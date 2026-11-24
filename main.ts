// Pump.fun Bot Sprint: Make Bot And Win — entry bot.
//
// Strategy: early-momentum sniper on fresh bonding curves, sized by the
// harness's own reserve cap, with a ladder exit and a hard stop.
//
// The dev window (24h, 1,222 mints) shows the shape of this market: a coin
// that runs does it FAST (median 155 slots from creation to peak for coins
// that 2x), and almost nothing holds its gains (only 3.9% of coins end the
// window 1.5x above their first-trade price). So the bot enters early on
// confirmed buy flow, takes profit on the spike, and never overstays.
//
// Entry: within the first 100 slots after a coin's creation, once cumulative
// buys reach 2 SOL across at least 3 buy trades. Forward calibration on the
// dev window: 44.7% of such entries peak 1.5x or better, 25.0% peak 2x, and
// only 15.7% hit -25% before +50%. The bot scales in toward a 0.3 SOL
// target as the 1%-of-real-reserve buy cap opens up, while the price stays
// within 25% of entry and within 300 slots of the first fill.
//
// Exits (checked every batch, all in cost-basis terms, bigint math):
//   - take-profit 1: value >= 1.5x cost  -> sell half
//   - take-profit 2: value >= 2.2x cost  -> sell all
//   - trailing stop: after TP1, value falls to 70% of its peak ratio -> sell all
//   - stop-loss:     value <= 0.75x cost -> sell all
//   - time exit:     900 slots after the first fill with no exit yet -> sell all
// Risk: at most 5 open positions (the harness cap), and entries halt if
// marked equity draws down 20% from its peak. No shorts, no leverage.
//
// Determinism: every decision comes from the event stream alone. No clock,
// no environment, no Math.random, no floats in any decision (all ratios are
// compared by bigint cross-multiplication). Two runs on the same data
// produce the same action log.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

const SOL = LAMPORTS_PER_SOL;

// ---- entry ---------------------------------------------------------------
const ENTRY_BUY_LAMPORTS = 2n * SOL; // cumulative buys that confirm flow
const ENTRY_WINDOW_SLOTS = 100; // after creation
const ENTRY_MIN_BUYS = 3; // distinct buy trades in the window
const TARGET_LAMPORTS = 300_000_000n; // 0.3 SOL per position
const MIN_BUY_LAMPORTS = 20_000_000n; // 0.02 SOL: below this, skip the batch
const SCALE_WINDOW_SLOTS = 300; // scale-in only this long after first fill
const MAX_NEW_PER_BATCH = 3;

// ---- exits ---------------------------------------------------------------
const TIME_EXIT_SLOTS = 900; // ~6 minutes of slots
const SLIPPAGE_BPS = 500;

// ---- risk ----------------------------------------------------------------
const DRAWDOWN_HALT_BPS = 2_000; // halt new entries at -20% equity
const MAX_ORDERS_PER_BATCH = 12; // under the harness cap of 16

interface Watch {
  created: number;
  buyVol: bigint;
  buys: number;
  entered: boolean;
}

interface Track {
  entrySlot: number;
  tp1: boolean;
  // Peak value/cost ratio, as a rational peakNum / peakDen.
  peakNum: bigint;
  peakDen: bigint;
}

const watch = new Map<string, Watch>();
const track = new Map<string, Track>();
let peakEquity = 0n;
let halted = false;

/** Current value of a position in lamports (integer division; guard use only). */
function markValue(state: BotState, mint: string, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.virtual_token_reserves === 0n) return 0n;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

/** Marked equity: cash plus every position at its current mark. */
function equity(state: BotState): bigint {
  let total = state.cash;
  for (const [mint, pos] of state.positions) {
    total += markValue(state, mint, pos.token_amount);
  }
  return total;
}

/** SOL already committed to a mint: held cost plus pending buys. */
function committed(state: BotState, mint: string): bigint {
  let total = state.positions.get(mint)?.cost_lamports ?? 0n;
  for (const p of state.pending.values()) {
    if (p.order.side === "buy" && p.order.mint === mint) {
      total += BigInt(p.order.quote_lamports);
    }
  }
  return total;
}

function hasPendingSell(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === "sell" && p.order.mint === mint) return true;
  }
  return false;
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const slot = state.slot;

  // -- 1. folds fills: record first-fill slots for new positions -----------
  for (const fill of batch.fills) {
    if (fill.side === "buy" && fill.status === "filled") {
      const t = track.get(fill.mint);
      if (t === undefined) {
        track.set(fill.mint, {
          entrySlot: fill.slot,
          tp1: false,
          peakNum: 0n,
          peakDen: 1n,
        });
      }
    }
  }

  // -- 2. fold events: watch new coins, confirm entry triggers -------------
  const candidates: string[] = [];
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      if (!watch.has(e.mint)) {
        watch.set(e.mint, { created: e.slot, buyVol: 0n, buys: 0, entered: false });
      }
    } else if (e.event === "TradeEvent") {
      if (!e.is_buy) continue;
      const w = watch.get(e.mint);
      if (w === undefined || w.entered) continue;
      if (slot - w.created > ENTRY_WINDOW_SLOTS) continue;
      w.buyVol += BigInt(e.sol_amount);
      w.buys += 1;
      if (w.buyVol >= ENTRY_BUY_LAMPORTS && w.buys >= ENTRY_MIN_BUYS) {
        w.entered = true;
        candidates.push(e.mint);
      }
    } else {
      // CompleteEvent: the curve migrated; the harness closes the position.
      watch.delete(e.mint);
      track.delete(e.mint);
    }
  }

  // -- 3. sync trackers with the account ------------------------------------
  for (const mint of [...track.keys()]) {
    if (!state.positions.has(mint) && committed(state, mint) === 0n) {
      track.delete(mint);
    }
  }
  for (const mint of state.positions.keys()) {
    if (!track.has(mint)) {
      track.set(mint, { entrySlot: slot, tp1: false, peakNum: 0n, peakDen: 1n });
    }
  }

  // -- 4. drawdown guard -----------------------------------------------------
  const eq = equity(state);
  if (peakEquity === 0n) peakEquity = eq;
  if (eq > peakEquity) peakEquity = eq;
  if (!halted && eq * 10_000n < peakEquity * (10_000n - BigInt(DRAWDOWN_HALT_BPS))) {
    halted = true;
    console.error(`halt: equity drawdown over 20% at slot ${slot}`);
  }

  // -- 5. exits, one decision per open position ------------------------------
  for (const [mint, pos] of state.positions) {
    if (orders.length >= MAX_ORDERS_PER_BATCH) break;
    if (hasPendingSell(state, mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const t = track.get(mint);
    if (t === undefined) continue;
    const tokens = pos.token_amount;
    const cost = pos.cost_lamports;
    if (tokens === 0n || cost === 0n) continue;
    if (curve.virtual_token_reserves === 0n) continue;

    // value/cost as the rational curNum / curDen (no floats anywhere).
    const curNum = tokens * curve.virtual_quote_reserves;
    const curDen = curve.virtual_token_reserves * cost;

    // Track the peak value/cost ratio for the trailing stop.
    if (curNum * t.peakDen > t.peakNum * curDen) {
      t.peakNum = curNum;
      t.peakDen = curDen;
    }

    const age = slot - t.entrySlot;
    let sell: bigint | null = null;
    if (curNum * 4n <= curDen * 3n) {
      sell = tokens; // stop-loss: value at or below 75% of cost
    } else if (curNum * 5n >= curDen * 11n) {
      sell = tokens; // take-profit 2: value at or above 2.2x cost
    } else if (t.tp1 && curNum * t.peakDen * 10n <= t.peakNum * curDen * 7n) {
      sell = tokens; // trailing stop: value fell to 70% of its peak ratio
    } else if (!t.tp1 && curNum * 2n >= curDen * 3n) {
      sell = tokens / 2n; // take-profit 1: value at or above 1.5x cost
      t.tp1 = true;
    } else if (age > TIME_EXIT_SLOTS) {
      sell = tokens; // time exit: no thesis left, free the slot
    }
    if (sell !== null && sell > 0n) {
      orders.push({ side: "sell", mint, token_amount: sell, max_slippage_bps: SLIPPAGE_BPS });
    }
  }

  // -- 6. entries and scale-ins ----------------------------------------------
  if (!halted) {
    const maxPositions = state.hello.caps.max_open_positions;
    let opened = 0;
    // 6a. fresh entries, in first-trigger order.
    for (const mint of candidates) {
      if (orders.length >= MAX_ORDERS_PER_BATCH || opened >= MAX_NEW_PER_BATCH) break;
      if (state.committedPositionCount() >= maxPositions) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (state.positions.has(mint)) continue;
      const cap = state.maxBuyLamports(mint);
      const size = cap < TARGET_LAMPORTS ? cap : TARGET_LAMPORTS;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
      orders.push({ side: "buy", mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
      opened += 1;
    }
    // 6b. scale-ins toward the target while the entry stays fresh.
    if (orders.length < MAX_ORDERS_PER_BATCH) {
      for (const [mint, t] of track) {
        if (orders.length >= MAX_ORDERS_PER_BATCH) break;
        if (slot - t.entrySlot > SCALE_WINDOW_SLOTS) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const have = committed(state, mint);
        if (have >= TARGET_LAMPORTS) continue;
        // Only add while the price is still near the entry (within +25%):
        // never chase a spike with fresh size.
        const pos = state.positions.get(mint);
        if (pos === undefined || pos.cost_lamports === 0n) continue;
        if (curve.virtual_token_reserves === 0n) continue;
        const curNum = pos.token_amount * curve.virtual_quote_reserves;
        const curDen = curve.virtual_token_reserves * pos.cost_lamports;
        if (curNum * 4n > curDen * 5n) continue; // value above 1.25x cost
        const cap = state.maxBuyLamports(mint);
        const want = TARGET_LAMPORTS - have;
        const size = cap < want ? cap : want;
        if (size < MIN_BUY_LAMPORTS) continue;
        if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
        orders.push({ side: "buy", mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
      }
    }
  }

  return orders;
}

await runBot({
  onHello(state) {
    console.error(
      `bot up: capital ${state.hello.capital.lamports} lamports, ` +
        `max positions ${state.hello.caps.max_open_positions}, ` +
        `seed ${state.hello.seed}`,
    );
  },
  onBatch,
  onDone(state, done) {
    console.error(
      `done (${done.reason}): cash ${state.cash}, ` +
        `positions ${state.positions.size}, halted ${halted}`,
    );
  },
});
