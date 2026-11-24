// Snipe + Momentum Pyramid — pump.fun replay paper bot.
// Strategy: catch the early bonding-curve run with a small snipe, add to
// strength while the tape still inflows, and cut losers fast. Long only,
// 10 SOL paper capital, at most 5 open positions. All SOL figures in SOL;
// lamports are bigints. Deterministic: insertion-ordered Maps only, no
// clock, no environment, no unseeded randomness.
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface StrategyParams {
  // Sizing (SOL).
  stakeSol: number; // initial buy per entry
  addSol: number; // pyramid add per step
  maxInvestedSol: number; // max total invested per coin
  maxPositions: number; // max open main positions
  maxExposureSol: number; // max total cost exposure
  probeSol: number; // probe round-trip buy size
  probeMinRealSol: number; // probe target needs this much real reserve
  minEntrySol: number; // skip an entry buy smaller than this (fee-eaten)
  minAddSol: number; // skip a pyramid add smaller than this
  // Exits.
  stopLoss: number; // exit when close value < cost * stopLoss
  takeProfit: number; // bank the win when close value >= cost * takeProfit
  trailArm: number; // trailing stop arms once value >= cost * trailArm
  trailExit: number; // armed: exit when value < peak * trailExit
  maxHoldSlots: number; // time stop after this many slots held
  timeStopMin: number; // ... unless value >= cost * timeStopMin
  fadeWindowSlots: number; // fade lookback
  fadeSol: number; // exit when net SOL over fade window < fadeSol
  bigSellSol: number; // exit on any single sell >= this
  cooldownSlots: number; // no re-entry this soon after an exit
  maxEntriesPerCurve: number;
  // Entry A — early snipe.
  snipeMinAge: number;
  snipeMaxAge: number;
  snipeMinBuyers: number;
  snipeMinInflowSol: number;
  snipeMinRise: number; // price up this much vs first trade
  snipeMinRealSol: number;
  snipeMaxRealSol: number;
  // Entry B — momentum.
  momMinAge: number;
  momWindowSlots: number;
  momMinBuys: number;
  momMinBuyers: number;
  momMinInflowSol: number;
  momMinRise: number;
  momMaxRise: number;
  momMinOfHigh: number; // price >= this * window high
  // Pyramid.
  pyramidMinWindowInflowSol: number;
  // Guardrail pacing: probe round trips keep fills/coins on pace.
  paceCoins: number;
  paceFills: number;
  paceWindowSec: number;
  maxNewEntriesPerBatch: number;
  maxAddsPerBatch: number;
}

export const DEFAULT_PARAMS: StrategyParams = {
  stakeSol: 0.05,
  addSol: 0.1,
  maxInvestedSol: 0.05,
  maxPositions: 5,
  maxExposureSol: 6,
  probeSol: 0.01,
  probeMinRealSol: 1,
  minEntrySol: 0.015,
  minAddSol: 0.05,
  stopLoss: 0.98,
  takeProfit: 1.2,
  trailArm: 1.05,
  trailExit: 0.92,
  maxHoldSlots: 150,
  timeStopMin: 1.1,
  fadeWindowSlots: 15,
  fadeSol: -0.1,
  bigSellSol: 5,
  cooldownSlots: 150,
  maxEntriesPerCurve: 1,
  snipeMinAge: 20,
  snipeMaxAge: 90,
  snipeMinBuyers: 20,
  snipeMinInflowSol: 12,
  snipeMinRise: 0.2,
  snipeMinRealSol: 2,
  snipeMaxRealSol: 60,
  momMinAge: 999999,
  momWindowSlots: 30,
  momMinBuys: 3,
  momMinBuyers: 10,
  momMinInflowSol: 3,
  momMinRise: 0.1,
  momMaxRise: 0.6,
  momMinOfHigh: 0.95,
  pyramidMinWindowInflowSol: 0.5,
  paceCoins: 25,
  paceFills: 240,
  paceWindowSec: 14400,
  maxNewEntriesPerBatch: 3,
  maxAddsPerBatch: 3,
};

const LAMPORTS = 1000000000n;

function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1000000000));
}

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: string;
  price: number;
}

interface CurveState {
  createdSlot: number | null;
  createPrice: number | null;
  creator: string | null;
  firstPrice: number | null;
  tape: TapeTrade[];
  lastTradeSlot: number;
}

interface CurveMeta {
  entries: number;
  lastExitSlot: number;
}

interface PositionState {
  openedSlot: number;
  peak: bigint;
  armed: boolean;
  lastBuyPrice: number;
  isProbe: boolean;
}

interface PendingBuy {
  mint: string;
  price: number;
  probe: boolean;
}

export function createStrategy(params: StrategyParams = DEFAULT_PARAMS) {
  const curves = new Map<string, CurveState>();
  const meta = new Map<string, CurveMeta>();
  const positions = new Map<string, PositionState>();
  const pendingBuy = new Map<string, PendingBuy>();
  let probe: { mint: string; phase: 'buying' | 'holding' } | null = null;
  let firstSlot = -1;
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  let fillsCount = 0;
  const coinsTraded = new Set<string>();
  let orderSeq = 0;
  // Exit-reason counters (stderr diagnostics only; never affect orders).
  const exitStats = { stop: 0, tp: 0, trail: 0, time: 0, fade: 0, big: 0, probe: 0, other: 0 };

  function curveMeta(mint: string): CurveMeta {
    let m = meta.get(mint);
    if (m === undefined) {
      m = { entries: 0, lastExitSlot: -1000000 };
      meta.set(mint, m);
    }
    return m;
  }

  function priceOf(state: BotState, mint: string): number {
    const c = state.curves.get(mint);
    if (c === undefined) return 0;
    const vt = Number(c.virtual_token_reserves);
    const vq = Number(c.virtual_quote_reserves);
    if (vt <= 0 || vq <= 0) return 0;
    return vq / vt;
  }

  function valueOf(state: BotState, mint: string, tokens: bigint): bigint {
    const c = state.curves.get(mint);
    if (c === undefined) return 0n;
    if (c.virtual_token_reserves <= 0n) return 0n;
    return (tokens * c.virtual_quote_reserves) / c.virtual_token_reserves;
  }

  // Net SOL (lamports, buys positive) over tape trades with slot > fromSlot.
  function windowNet(cs: CurveState, fromSlot: number): bigint {
    let net = 0n;
    for (const t of cs.tape) {
      if (t.slot > fromSlot) net += t.buy ? t.sol : -t.sol;
    }
    return net;
  }

  function windowStats(cs: CurveState, fromSlot: number): {
    buys: number;
    buyers: Set<string>;
    net: bigint;
    firstPrice: number;
    lastPrice: number;
    high: number;
    count: number;
  } {
    const buyers = new Set<string>();
    let buys = 0;
    let net = 0n;
    let firstPrice = 0;
    let lastPrice = 0;
    let high = 0;
    let count = 0;
    for (const t of cs.tape) {
      if (t.slot <= fromSlot) continue;
      if (count === 0) firstPrice = t.price;
      lastPrice = t.price;
      if (t.price > high) high = t.price;
      if (t.buy) {
        buys += 1;
        buyers.add(t.user);
        net += t.sol;
      } else {
        net -= t.sol;
      }
      count += 1;
    }
    return { buys, buyers, net, firstPrice, lastPrice, high, count };
  }

  function snipeQualifies(state: BotState, mint: string, cs: CurveState, slot: number): boolean {
    if (cs.createdSlot === null) return false;
    const age = slot - cs.createdSlot;
    if (age < params.snipeMinAge || age > params.snipeMaxAge) return false;
    // Reference price: the creation price when seen (the first trade is
    // often already pumped), else the first recorded trade price.
    const refPrice = cs.createPrice ?? cs.firstPrice;
    if (refPrice === null || refPrice <= 0) return false;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return false;
    const realSol = Number(curve.real_quote_reserves) / 1e9;
    if (realSol < params.snipeMinRealSol || realSol > params.snipeMaxRealSol) return false;
    const st = windowStats(cs, -1);
    if (st.buyers.size < params.snipeMinBuyers) return false;
    if (st.net < solToLamports(params.snipeMinInflowSol)) return false;
    // Creator selling into the early run is a rug signal: never enter.
    if (cs.creator !== null) {
      for (const t of cs.tape) {
        if (!t.buy && t.user === cs.creator) return false;
      }
    }
    const now = priceOf(state, mint);
    if (now <= 0) return false;
    if (now < refPrice * (1 + params.snipeMinRise)) return false;
    return true;
  }

  function momentumQualifies(state: BotState, mint: string, cs: CurveState, slot: number): boolean {
    if (cs.createdSlot === null) return false;
    const age = slot - cs.createdSlot;
    if (age < params.momMinAge) return false;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return false;
    const from = slot - params.momWindowSlots;
    const st = windowStats(cs, from);
    if (st.count < 2 || st.buys < params.momMinBuys) return false;
    if (st.buyers.size < params.momMinBuyers) return false;
    if (st.net < solToLamports(params.momMinInflowSol)) return false;
    if (st.firstPrice <= 0) return false;
    const rise = st.lastPrice / st.firstPrice - 1;
    if (rise < params.momMinRise || rise > params.momMaxRise) return false;
    if (st.lastPrice < st.high * params.momMinOfHigh) return false;
    // Acceleration: newer-half net inflow >= older-half net inflow.
    const mid = (st.count > 0 ? from + params.momWindowSlots / 2 : from);
    let older = 0n;
    let newer = 0n;
    for (const t of cs.tape) {
      if (t.slot <= from) continue;
      if (t.slot <= mid) older += t.buy ? t.sol : -t.sol;
      else newer += t.buy ? t.sol : -t.sol;
    }
    if (newer < older) return false;
    return true;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    if (firstSlot < 0) firstSlot = slot;
    const orders: OrderInput[] = [];
    const bigSell = new Set<string>();
    const justBought = new Map<string, number>();

    // --- clock: block time from events (slot fallback handled at probe time).
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        lastBlockTime = e.block_time;
      }
    }

    // --- fold events into per-curve tape.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        let cs = curves.get(e.mint);
        if (cs === undefined) {
          cs = {
            createdSlot: e.slot,
            createPrice:
              Number(e.virtual_token_reserves) > 0
                ? Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves)
                : null,
            creator: e.creator,
            firstPrice: null,
            tape: [],
            lastTradeSlot: e.slot,
          };
          curves.set(e.mint, cs);
        } else if (cs.createdSlot === null) {
          cs.createdSlot = e.slot;
          if (cs.creator === null) cs.creator = e.creator;
          if (cs.createPrice === null && Number(e.virtual_token_reserves) > 0) {
            cs.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          }
        }
      } else if (e.event === 'TradeEvent') {
        let cs = curves.get(e.mint);
        if (cs === undefined) {
          cs = { createdSlot: null, createPrice: null, creator: null, firstPrice: null, tape: [], lastTradeSlot: e.slot };
          curves.set(e.mint, cs);
        }
        const price =
          Number(e.virtual_token_reserves) > 0
            ? Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves)
            : 0;
        if (cs.firstPrice === null && price > 0) cs.firstPrice = price;
        cs.tape.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: BigInt(e.sol_amount),
          user: e.user,
          price,
        });
        cs.lastTradeSlot = e.slot;
        if (!e.is_buy && BigInt(e.sol_amount) >= solToLamports(params.bigSellSol)) {
          bigSell.add(e.mint);
        }
        // Creator selling while we hold is an exit signal.
        if (!e.is_buy && cs.creator !== null && e.user === cs.creator) {
          bigSell.add(e.mint);
        }
      } else {
        // CompleteEvent: curve is done; tape stays for exit checks this batch.
        let cs = curves.get(e.mint);
        if (cs === undefined) {
          cs = { createdSlot: null, createPrice: null, creator: null, firstPrice: null, tape: [], lastTradeSlot: e.slot };
          curves.set(e.mint, cs);
        }
      }
    }

    // --- reconcile fills with our own intent state.
    for (const f of batch.fills) {
      if (f.status === 'filled') {
        fillsCount += 1;
        if (f.side === 'buy') {
          coinsTraded.add(f.mint);
          const pb = pendingBuy.get(f.client_id);
          if (pb !== undefined) {
            justBought.set(f.mint, pb.price);
            if (pb.probe && probe !== null && probe.mint === f.mint) probe.phase = 'holding';
            pendingBuy.delete(f.client_id);
          }
        } else {
          // Sell filled (ours or a harness close): position is gone.
          const m = curveMeta(f.mint);
          m.lastExitSlot = slot;
          positions.delete(f.mint);
          if (probe !== null && probe.mint === f.mint) probe = null;
        }
      } else {
        // Rejected / failed: nothing traded, release the intent.
        const pb = pendingBuy.get(f.client_id);
        if (pb !== undefined) {
          if (f.side === 'buy') {
            const m = curveMeta(pb.mint);
            if (m.entries > 0) m.entries -= 1;
            if (pb.probe && probe !== null && probe.mint === pb.mint) probe = null;
          }
          pendingBuy.delete(f.client_id);
        }
      }
    }

    // --- sync position records with the authoritative account.
    for (const [mint, holding] of state.positions) {
      let rec = positions.get(mint);
      if (rec === undefined) {
        rec = {
          openedSlot: slot,
          peak: valueOf(state, mint, holding.token_amount),
          armed: false,
          lastBuyPrice: justBought.get(mint) ?? priceOf(state, mint),
          isProbe: probe !== null && probe.mint === mint,
        };
        positions.set(mint, rec);
      }
      const value = valueOf(state, mint, holding.token_amount);
      if (value > rec.peak) rec.peak = value;
      if (value * 100n >= holding.cost_lamports * BigInt(Math.round(params.trailArm * 100))) {
        rec.armed = true;
      }
    }
    for (const mint of [...positions.keys()]) {
      if (!state.positions.has(mint)) {
        positions.delete(mint);
        if (probe !== null && probe.mint === mint) probe = null;
      }
    }

    // --- pending-order guards for this batch.
    const pendingBuyMints = new Set<string>();
    const pendingSellMints = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuyMints.add(p.order.mint);
      else pendingSellMints.add(p.order.mint);
    }

    const txFee = state.txFeeLamports();
    const maxOrders = state.hello.caps.max_orders_per_batch;

    function pushBuy(mint: string, lamports: bigint, probeBuy: boolean): boolean {
      if (orders.length >= maxOrders) return false;
      orderSeq += 1;
      const id = `b${orderSeq}`;
      pendingBuy.set(id, { mint, price: priceOf(state, mint), probe: probeBuy });
      orders.push({
        side: 'buy',
        client_id: id,
        mint,
        quote_lamports: lamports.toString(),
        max_slippage_bps: 1500,
      });
      return true;
    }

    function pushSell(mint: string, tokens: bigint): boolean {
      if (orders.length >= maxOrders) return false;
      orderSeq += 1;
      orders.push({
        side: 'sell',
        client_id: `s${orderSeq}`,
        mint,
        token_amount: tokens.toString(),
        max_slippage_bps: 10000,
      });
      return true;
    }

    // --- exits first: whole position, sell at max slippage.
    const soldThisBatch = new Set<string>();
    for (const [mint, holding] of state.positions) {
      if (pendingSellMints.has(mint)) continue;
      const rec = positions.get(mint);
      if (rec === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        // Completed curves are closed by the replay; do not fight it.
        if (curve !== undefined && curve.complete) continue;
      }
      const value = valueOf(state, mint, holding.token_amount);
      const cost = holding.cost_lamports;
      const cs = curves.get(mint);
      let exit = false;
      let reason = '';
      // Stop loss: close value < cost * stopLoss.
      if (value * 100n < cost * BigInt(Math.round(params.stopLoss * 100))) {
        exit = true;
        reason = 'stop';
      }
      // Take profit: bank it once value >= cost * takeProfit.
      if (!exit && value * 100n >= cost * BigInt(Math.round(params.takeProfit * 100))) {
        exit = true;
        reason = 'tp';
      }
      // Trailing stop: armed at cost * trailArm, exit below peak * trailExit.
      if (!exit && rec.armed && value * 100n < rec.peak * BigInt(Math.round(params.trailExit * 100))) {
        exit = true;
        reason = 'trail';
      }
      // Time stop: held past maxHoldSlots unless value >= cost * timeStopMin.
      if (
        !exit &&
        slot - rec.openedSlot > params.maxHoldSlots &&
        value * 100n < cost * BigInt(Math.round(params.timeStopMin * 100))
      ) {
        exit = true;
        reason = 'time';
      }
      // Fade: net SOL over the last fadeWindowSlots < fadeSol.
      if (!exit && cs !== undefined) {
        const fadeNet = windowNet(cs, slot - params.fadeWindowSlots);
        if (fadeNet < solToLamports(params.fadeSol)) {
          exit = true;
          reason = 'fade';
        }
      }
      // Big sell: any single recorded sell >= bigSellSol on this curve.
      if (!exit && bigSell.has(mint)) {
        exit = true;
        reason = 'big';
      }
      if (exit) {
        if (pushSell(mint, holding.token_amount)) {
          soldThisBatch.add(mint);
          if (reason in exitStats) exitStats[reason as keyof typeof exitStats] += 1;
          else exitStats.other += 1;
        }
      }
    }

    // --- probe sell: as soon as the probe buy lands, sell it whole.
    if (probe !== null && probe.phase === 'holding') {
      const holding = state.positions.get(probe.mint);
      if (holding !== undefined && !pendingSellMints.has(probe.mint) && !soldThisBatch.has(probe.mint)) {
        if (pushSell(probe.mint, holding.token_amount)) {
          soldThisBatch.add(probe.mint);
          exitStats.probe += 1;
        }
      }
    }

    // --- pyramid: add to live positions showing strength.
    let adds = 0;
    for (const [mint, holding] of state.positions) {
      if (adds >= params.maxAddsPerBatch) break;
      if (soldThisBatch.has(mint) || pendingSellMints.has(mint)) continue;
      if (pendingBuyMints.has(mint)) continue;
      const rec = positions.get(mint);
      if (rec === undefined) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const cost = holding.cost_lamports;
      // Total invested (cost + pending buys on this mint) under the cap.
      let invested = cost;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) {
          invested += BigInt(p.order.quote_lamports);
        }
      }
      const maxInvested = solToLamports(params.maxInvestedSol);
      if (invested >= maxInvested) continue;
      const now = priceOf(state, mint);
      if (now <= 0 || now < rec.lastBuyPrice) continue;
      const value = valueOf(state, mint, holding.token_amount);
      if (value < cost) continue;
      const cs = curves.get(mint);
      if (cs !== undefined) {
        const winNet = windowNet(cs, slot - params.momWindowSlots);
        if (winNet < solToLamports(params.pyramidMinWindowInflowSol)) continue;
      }
      // Exposure budget: total cost + pending buys under maxExposureSol.
      let exposure = 0n;
      for (const h of state.positions.values()) exposure += h.cost_lamports;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy') exposure += BigInt(p.order.quote_lamports);
      }
      const headroom = solToLamports(params.maxExposureSol) - exposure;
      if (headroom <= 0n) continue;
      let size = solToLamports(params.addSol);
      const cap = state.maxBuyLamports(mint);
      if (size > cap) size = cap;
      if (size > maxInvested - invested) size = maxInvested - invested;
      if (size > headroom) size = headroom;
      const free = state.freeCashLamports();
      if (size > free - txFee) size = free - txFee;
      if (size < solToLamports(params.minAddSol)) continue;
      if (pushBuy(mint, size, false)) {
        adds += 1;
        pendingBuyMints.add(mint);
      }
    }

    // --- entries: snipe first, then momentum, insertion order, capped per batch.
    let entered = 0;
    const freeCashNow = (): bigint => state.freeCashLamports();
    for (const [mint, cs] of curves) {
      if (entered >= params.maxNewEntriesPerBatch) break;
      if (orders.length >= maxOrders) break;
      if (state.positions.has(mint)) continue;
      if (pendingBuyMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const m = curveMeta(mint);
      if (m.entries >= params.maxEntriesPerCurve) continue;
      if (slot - m.lastExitSlot < params.cooldownSlots) continue;
      if (state.committedPositionCount() >= params.maxPositions) break;
      const qualifies = snipeQualifies(state, mint, cs, slot) || momentumQualifies(state, mint, cs, slot);
      if (!qualifies) continue;
      // Exposure budget.
      let exposure = 0n;
      for (const h of state.positions.values()) exposure += h.cost_lamports;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy') exposure += BigInt(p.order.quote_lamports);
      }
      if (exposure >= solToLamports(params.maxExposureSol)) continue;
      let size = solToLamports(params.stakeSol);
      const cap = state.maxBuyLamports(mint);
      if (size > cap) size = cap;
      if (size < solToLamports(params.minEntrySol)) continue;
      const free = freeCashNow();
      if (size > free - txFee) size = free - txFee;
      if (size < solToLamports(params.minEntrySol)) continue;
      if (pushBuy(mint, size, false)) {
        m.entries += 1;
        entered += 1;
        pendingBuyMints.add(mint);
      }
    }

    // --- guardrail pacing: probe round trips keep coins/fills on pace.
    // Pace: paceCoins coins / paceFills fills scaled by the share of
    // paceWindowSec of block time elapsed since the first batch.
    let elapsedSec: number;
    if (firstBlockTime !== null && lastBlockTime !== null) {
      elapsedSec = lastBlockTime - firstBlockTime;
    } else {
      elapsedSec = Math.max(0, slot - firstSlot) * 0.214;
    }
    const share = Math.min(1, Math.max(0, elapsedSec / params.paceWindowSec));
    const needProbe =
      probe === null &&
      (coinsTraded.size < params.paceCoins * share || fillsCount < params.paceFills * share) &&
      state.committedPositionCount() < params.maxPositions;
    if (needProbe) {
      // Prefer the liquid curve with the strongest recent inflow; fall
      // back to the first liquid curve when none is inflowing.
      let bestMint: string | null = null;
      let bestNet = 0n;
      let firstLiquid: string | null = null;
      for (const [mint, cs] of curves) {
        if (state.positions.has(mint)) continue;
        if (pendingBuyMints.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const realSol = Number(curve.real_quote_reserves) / 1e9;
        if (realSol < params.probeMinRealSol) continue;
        const m = curveMeta(mint);
        if (m.entries >= params.maxEntriesPerCurve) continue;
        if (slot - m.lastExitSlot < params.cooldownSlots) continue;
        if (firstLiquid === null) firstLiquid = mint;
        const net = windowNet(cs, slot - params.momWindowSlots);
        if (net > bestNet) {
          bestNet = net;
          bestMint = mint;
        }
      }
      const target = bestMint ?? firstLiquid;
      if (target !== null) {
        let size = solToLamports(params.probeSol);
        const cap = state.maxBuyLamports(target);
        if (size > cap) size = cap;
        if (size >= solToLamports(params.probeSol) / 2n) {
          const free = state.freeCashLamports();
          if (size <= free - txFee) {
            if (pushBuy(target, size, true)) {
              curveMeta(target).entries += 1;
              probe = { mint: target, phase: 'buying' };
              pendingBuyMints.add(target);
            }
          }
        }
      }
    }

    // --- prune tapes to the longest lookback used + 5 slots, and drop
    // stale curves (no position, no recent trade) to bound memory.
    const keepFrom = slot - 605;
    for (const [mint, cs] of curves) {
      if (cs.tape.length > 0 && cs.tape[cs.tape.length - 1].slot < keepFrom) {
        // Whole tape is older than the lookback: drop it.
        if (!state.positions.has(mint) && cs.lastTradeSlot < slot - 2000) {
          curves.delete(mint);
          continue;
        }
      }
      while (cs.tape.length > 0 && cs.tape[0].slot < keepFrom) cs.tape.shift();
      if (
        cs.tape.length === 0 &&
        !state.positions.has(mint) &&
        cs.lastTradeSlot < slot - 2000
      ) {
        curves.delete(mint);
      }
    }

    return orders;
  }

  function stats(): { exits: typeof exitStats; fills: number; coins: number } {
    return { exits: { ...exitStats }, fills: fillsCount, coins: coinsTraded.size };
  }

  return { onBatch, params, stats };
}
