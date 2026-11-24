// Pump.fun Bot Sprint entry — "completion chase".
//
// A Solana paper-trading bot for pump.fun bonding curves (agent-fun/replay/v2).
// It watches every coin's real SOL reserve and buys the ones that rocket to
// 40 SOL of real reserve within 500 slots of creation, then holds for a 2x
// or cuts at -30%. One full-size entry, no scale-in, no ladder.
//
// Why this shape (all calibrated on the dev window, 1,222 coins, Nov 2-3):
// - The bonding curve is constant-product (vq*vt = 3.219e25, verified): price
//   is ((30+R)/30)^2 of creation at real reserve R, so completion at R=85 is
//   ~14.7x creation and an R=40 entry (5.4x) has 2.7x of headroom left.
// - Early-momentum entries (buy 2 SOL of flow in 100 slots) LOSE: the median
//   coin is at 0.75x of its trigger price 900 slots later, and every
//   early-entry / dip-buy / no-take-profit variant simulated negative
//   (-0.08 to -0.19 per trade after fees and 2-slot fill latency).
// - Late entries are the only ~breakeven family: R>=40, TP 2.0x, SL 0.7x is
//   -0.015/trade unfiltered, and +0.10/trade when restricted to coins that
//   reach R=40 within 500 slots of creation (n=33, win rate 39%). The fast
//   risers carry the edge: 6 of the 7 tradeable completers in the window
//   reached R=40 within 200 slots. Slow grinders (1000+ slots to R=40)
//   never complete.
// - The 2-slot fill latency plus ~2.6% round-trip fees is a ~10% tax on every
//   trade, which is why tight stops and small take-profits all lose: the
//   only winning shape is a wide stop (0.7x) with a big target (2.0x) on
//   coins that have already proven explosive demand.
// - 22 of 29 completers explode from trigger to graduation inside 2 slots
//   and are untradeable (the buy is rejected once the curve completes), so
//   the strategy does not depend on catching them — it depends on the
//   tradeable risers that take minutes, not slots, to finish the run.
//
// Risk: at most 5 open positions (harness cap); new entries halt if marked
// equity draws down 20% from its peak; every ratio is compared with bigint
// cross-multiplication (no floats); fully deterministic — every decision
// comes from the event stream alone, so two runs match byte for byte.

import { runBot, type Batch, type BotState, type OrderInput } from "./vendor/makefun-bot.ts";

// ---- entry -----------------------------------------------------------------
// Real reserve (lamports) a coin must reach to qualify.
const RESERVE_ENTRY_LAMPORTS = 40_000_000_000n; // 40 SOL
// The coin must reach that reserve within this many slots of its creation.
const MAX_SLOTS_TO_RESERVE = 500;
// After the first sighting at >= 40 SOL, the entry window stays open this long
// (covers the case where all 5 position slots are briefly full).
const ENTRY_WINDOW_SLOTS = 100;
// One full-size entry per coin; the 1% cap at R=40 is 0.40 SOL, so 0.35 leaves
// a buffer against a fill-time rejection if the reserve dips before the fill.
const ENTRY_LAMPORTS = 350_000_000n; // 0.35 SOL
const MIN_BUY_LAMPORTS = 20_000_000n; // 0.02 SOL: below this, skip the batch
const MAX_NEW_PER_BATCH = 3;

// ---- exits -----------------------------------------------------------------
// Take-profit 2.0x cost / stop-loss 0.7x cost / time exit 20,000 slots
// (~2.2 hours). No ladder, no trailing stop: the calibration says both cut
// the winners that pay for the losers.
const TIME_EXIT_SLOTS = 20_000;
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 10000; // on a crashing coin, a rejected sell is far
// worse than a bad fill — each retry costs another 2 slots of decay.

// ---- risk ------------------------------------------------------------------
const DRAWDOWN_HALT_BPS = 2_000; // halt new entries at -20% equity
const MAX_ORDERS_PER_BATCH = 12; // under the harness cap of 16

interface Watch {
  created: number; // slot of the CreateEvent
  r40slot: number; // first slot real reserve was seen >= 40 SOL (0 if never)
  entered: boolean; // a buy fill arrived for this mint
}

interface Track {
  entrySlot: number; // slot of the first buy fill (time-exit clock)
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

function hasPendingBuy(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === "buy" && p.order.mint === mint) return true;
  }
  return false;
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

  // -- 1. fold fills: record first-fill slots for new positions -------------
  for (const fill of batch.fills) {
    if (fill.side === "buy" && fill.status === "filled") {
      const w = watch.get(fill.mint);
      if (w !== undefined) w.entered = true;
      if (!track.has(fill.mint)) {
        track.set(fill.mint, { entrySlot: fill.slot });
      }
    }
  }

  // -- 2. fold events: record creations and reserve crossings ----------------
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      if (!watch.has(e.mint)) {
        watch.set(e.mint, { created: e.slot, r40slot: 0, entered: false });
      }
    } else if (e.event === "TradeEvent") {
      const w = watch.get(e.mint);
      if (w === undefined) continue;
      if (w.r40slot === 0 && e.real_quote_reserves >= RESERVE_ENTRY_LAMPORTS) {
        w.r40slot = e.slot;
      }
    }
  }
  // Coins without a CreateEvent in the stream (created before the window)
  // are never watched: their age is unknown, so the fast-riser filter
  // cannot verify them. Events arrive in chain order, so a coin's
  // CreateEvent always precedes its trades.
  if (watch.size > 8000) {
    // Deterministic cap: drop the oldest entries (insertion order).
    const drop = watch.size - 8000;
    let n = 0;
    for (const k of watch.keys()) {
      if (n++ >= drop) break;
      watch.delete(k);
    }
  }

  // -- 3. drawdown guard -----------------------------------------------------
  const eq = equity(state);
  if (peakEquity === 0n) peakEquity = eq;
  if (eq > peakEquity) peakEquity = eq;
  if (!halted && eq * 10_000n < peakEquity * (10_000n - BigInt(DRAWDOWN_HALT_BPS))) {
    halted = true;
    console.error(`halt: equity drawdown over 20% at slot ${slot}`);
  }

  // -- 4. exits: TP 2.0x / SL 0.7x / time 20,000 slots ------------------------
  for (const [mint, pos] of state.positions) {
    if (orders.length >= MAX_ORDERS_PER_BATCH) break;
    if (hasPendingSell(state, mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue; // completed positions
    // are force-closed by the harness at the completion value; nothing to do.
    const t = track.get(mint);
    if (t === undefined) continue;
    const tokens = pos.token_amount;
    const cost = pos.cost_lamports;
    if (tokens === 0n || cost === 0n) continue;
    if (curve.virtual_token_reserves === 0n) continue;

    // value/cost as the rational curNum / curDen (no floats anywhere).
    const curNum = tokens * curve.virtual_quote_reserves;
    const curDen = curve.virtual_token_reserves * cost;

    const age = slot - t.entrySlot;
    let sell: bigint | null = null;
    if (curNum * 10n <= curDen * 7n) {
      sell = tokens; // stop-loss: value at or below 70% of cost
    } else if (curNum >= curDen * 2n) {
      sell = tokens; // take-profit: value at or above 2x cost
    } else if (age > TIME_EXIT_SLOTS) {
      sell = tokens; // time exit: thesis expired
    }
    if (sell !== null && sell > 0n) {
      orders.push({ side: "sell", mint, token_amount: sell, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }
  }

  // -- 5. entries: fast risers to 40 SOL of real reserve ----------------------
  if (!halted) {
    const maxPositions = state.hello.caps.max_open_positions;
    let opened = 0;
    const stale: string[] = [];
    for (const [mint, w] of watch) {
      if (orders.length >= MAX_ORDERS_PER_BATCH || opened >= MAX_NEW_PER_BATCH) break;
      if (state.committedPositionCount() >= maxPositions) break;
      if (w.entered) continue;
      if (w.r40slot === 0) {
        // Too old to ever qualify: it can no longer reach R=40 within
        // 500 slots of its creation.
        if (slot - w.created > MAX_SLOTS_TO_RESERVE) stale.push(mint);
        continue;
      }
      if (w.r40slot - w.created > MAX_SLOTS_TO_RESERVE) { stale.push(mint); continue; } // slow grinder
      if (slot - w.r40slot > ENTRY_WINDOW_SLOTS) { stale.push(mint); continue; } // window closed
      if (state.positions.has(mint) || hasPendingBuy(state, mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < RESERVE_ENTRY_LAMPORTS) continue; // dipped back
      const cap = state.maxBuyLamports(mint);
      const size = cap < ENTRY_LAMPORTS ? cap : ENTRY_LAMPORTS;
      if (size < MIN_BUY_LAMPORTS) continue;
      if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
      orders.push({ side: "buy", mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
      opened += 1;
    }
    for (const mint of stale) watch.delete(mint);
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
