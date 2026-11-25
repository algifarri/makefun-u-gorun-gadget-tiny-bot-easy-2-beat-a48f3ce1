// Tiny Bot: two-sleeve trend + mean-reversion bot for agent-fun/bars-replay/v1.
//
// The final window is 3 whole UTC days of hourly bars (72 bars) whose direction is
// unknown, so the bot is built to beat buy-and-hold in either regime instead of
// betting on one: it stays mostly in cash when nothing trends, rides uptrends when
// they appear, and buys oversold bounces when the market chops sideways.
//
//   - Trend sleeve, per symbol: EMA(8) crosses above EMA(21) (both mean-seeded, so
//     the slow EMA needs 21 closes before it signals). Exit on the cross back down
//     or on a 3% trailing stop from the position's peak close.
//   - Mean-reversion sleeve, per symbol: RSI(14) at or under 30 (Wilder smoothing,
//     first value the mean of the first 14 changes). Exit when RSI reaches 55, or
//     the position is worth 3% over its cost, or 5% under it.
//   - Sizing: each entry spends equity / 14, capped by the 25% per-symbol weight cap
//     and the cash on hand; never more than the universe of open slots.
//   - Minimum-activity sweep: the competition needs at least 8 trades, and quiet
//     sideways windows barely signal. From bar 56 on, while filled trades plus open
//     positions are still short of 8, the bot takes small probe positions
//     (equity / 28) in the symbols with the strongest 6-bar momentum, exited like
//     trend positions. This keeps the entry trading even when no sleeve signals.
//
// Every order caps its slippage at 100 bps past the close it was decided on. All
// decisions are pure functions of the bars the harness has sent: no clock, no
// environment, no randomness, so the two graded executions agree byte for byte.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 8;
const SLOW_BARS = 21;
const RSI_BARS = 14;
const RSI_ENTRY_AT_MOST = 30;
const RSI_EXIT_AT_LEAST = 55;
const RSI_ROI = 0.03;
const RSI_STOP = 0.05;
const TRAIL = 0.03;
const STAKE_DIVISOR = 14;
const SWEEP_BAR = 56;
const SWEEP_NEED = 8;
const SWEEP_DIVISOR = 28;
const SWEEP_MOM_BARS = 6;
const MAX_SLIPPAGE_BPS = 100;

type Sleeve = 'trend' | 'rsi' | 'sweep';

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** fast - slow after the symbol's bar before this one, once both are set. */
  gap: number | null;
  /** The same after this bar. */
  now: number | null;
  /** The sell signal: set on a cross of EMA(21) above EMA(8), held while it stays under. */
  down: boolean;
  /** Closes seen, oldest first, for RSI and for the sweep's momentum. */
  closes: number[];
  /** Wilder RSI(14) running sums, then smoothed averages. */
  gains: number;
  losses: number;
  changes: number;
  rsi: number | null;
  /** The peak close since the position opened (trend/sweep exits trail it). */
  peak: number | null;
  /** Which sleeve opened the position now held, if any. */
  sleeve: Sleeve | null;
}

const series = new Map<string, Series>();
/** Each position's cost (its buy's notional) and the filled-trade count so far. */
const heldCost = new Map<string, bigint>();
let trades = 0;

function emaStep(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_BARS, warm: [], value: null },
      slow: { span: SLOW_BARS, warm: [], value: null },
      gap: null, now: null, down: false, closes: [],
      gains: 0, losses: 0, changes: 0, rsi: null, peak: null, sleeve: null,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  emaStep(s.fast, c);
  emaStep(s.slow, c);
  s.gap = s.now;
  s.now = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  if (s.now !== null && s.now >= 0) s.down = false;
  if (s.closes.length > 0) {
    const change = c - s.closes[s.closes.length - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    s.changes += 1;
    if (s.changes <= RSI_BARS) {
      s.gains += gain;
      s.losses += loss;
      if (s.changes === RSI_BARS) {
        const avgGain = s.gains / RSI_BARS;
        const avgLoss = s.losses / RSI_BARS;
        s.gains = avgGain;
        s.losses = avgLoss;
        s.rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    } else {
      s.gains = (s.gains * (RSI_BARS - 1) + gain) / RSI_BARS;
      s.losses = (s.losses * (RSI_BARS - 1) + loss) / RSI_BARS;
      s.rsi = s.losses === 0 ? 100 : 100 - 100 / (1 + s.gains / s.losses);
    }
  }
  s.closes.push(c);
  return s;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      trades += 1;
      const s = series.get(f.symbol);
      if (f.side === 'buy') {
        const held = state.positions.get(f.symbol);
        if (held !== undefined) heldCost.set(f.symbol, held.cost);
        const bar = batch.bars.find((b) => b.symbol === f.symbol);
        if (s !== undefined && bar !== undefined) s.peak = Number(bar.c);
      } else if (state.positions.get(f.symbol) === undefined) {
        heldCost.delete(f.symbol);
        if (s !== undefined) {
          s.peak = null;
          s.sleeve = null;
        }
      }
    }
    const crossUp = new Set<string>();
    const rsiUp = new Set<string>();
    for (const bar of batch.bars) {
      const s = push(bar);
      if (bar.v === '0') continue;
      if (s.gap !== null && s.now !== null) {
        if (s.now > 0 && s.gap <= 0) crossUp.add(bar.symbol);
        if (s.now < 0 && s.gap >= 0) s.down = true;
      }
      if (s.rsi !== null && s.rsi <= RSI_ENTRY_AT_MOST) rsiUp.add(bar.symbol);
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: { symbol: string; sleeve: Sleeve }[] = [];
    for (const { symbol } of state.hello.symbols) {
      const s = series.get(symbol);
      if (s === undefined) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        const value = state.value(symbol, held.qty);
        const cost = heldCost.get(symbol) ?? held.cost;
        let doSell = false;
        if (s.sleeve === 'trend' || s.sleeve === 'sweep') {
          if (s.down) doSell = true;
          if (s.peak !== null) {
            const closeNum = Number(state.close(symbol));
            if (closeNum > s.peak) s.peak = closeNum;
            const peakValue = state.value(symbol, held.qty, BigInt(s.peak));
            if (value * 100n <= peakValue * BigInt(Math.round((1 - TRAIL) * 100))) doSell = true;
          }
        } else {
          if (s.rsi !== null && s.rsi >= RSI_EXIT_AT_LEAST) doSell = true;
          if (value * 100n >= cost * BigInt(Math.round((1 + RSI_ROI) * 100))) doSell = true;
          if (value * 100n <= cost * BigInt(Math.round((1 - RSI_STOP) * 100))) doSell = true;
        }
        if (doSell) sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      } else if (crossUp.has(symbol)) {
        entries.push({ symbol, sleeve: 'trend' });
      } else if (rsiUp.has(symbol)) {
        entries.push({ symbol, sleeve: 'rsi' });
      }
    }

    // Minimum-activity sweep (see the header): quiet windows barely signal, so
    // from bar 56 on, top up the trade count with small momentum probes.
    if (batch.seq >= SWEEP_BAR) {
      const open = [...state.positions.keys()].length;
      const short = SWEEP_NEED - (trades + open);
      if (short > 0) {
        const ranked = [...series.entries()]
          .filter(([symbol, s]) => s.closes.length > SWEEP_MOM_BARS && !state.positions.has(symbol) && !entries.some((e) => e.symbol === symbol))
          .map(([symbol, s]) => ({ symbol, mom: s.closes[s.closes.length - 1] / s.closes[s.closes.length - 1 - SWEEP_MOM_BARS] - 1 }))
          .sort((a, b) => (b.mom !== a.mom ? b.mom - a.mom : b.symbol < a.symbol ? 1 : b.symbol > a.symbol ? -1 : 0));
        for (const { symbol } of ranked.slice(0, short)) entries.push({ symbol, sleeve: 'sweep' });
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(STAKE_DIVISOR);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const { symbol, sleeve } of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      const divisor = sleeve === 'sweep' ? SWEEP_DIVISOR : STAKE_DIVISOR;
      let slice = state.equity / BigInt(divisor);
      if (slice > byWeight) slice = byWeight;
      if (slice > cash) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      series.get(symbol)!.sleeve = sleeve;
      cash -= slice;
      room--;
    }
    return orders;
  },
});
