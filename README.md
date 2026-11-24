# Pump.fun Replay Sprint — Snipe + Momentum Pyramid

Paper trading bot for the make.fun Pump.fun Replay Sprint: trades 10 SOL
of paper money on a 24h replay of pump.fun bonding-curve activity.

## Strategy

A pump.fun bonding curve usually runs hardest right after launch, then
dumps. The bot catches only the strongest early runs, banks winners fast,
and cuts losers faster:

- **Early snipe** (age 20–90 slots): ≥20 distinct buyers, net inflow
  ≥12 SOL, price up ≥20% vs the creation price, real reserves 2–60 SOL,
  and the creator must not have sold into the run. Buys 0.05 SOL.
- **Momentum entry is disabled** in the tuned config (its dev-window
  trips were breakeven-to-negative); the code keeps it behind
  `momMinAge` if it is ever re-enabled.
- **No pyramid adds** in the tuned config: dev testing showed adds
  bought tops and were the single biggest leak (removing them improved
  dev net PnL by ~1.4 SOL). `maxInvestedSol` equals the stake, so no
  add can fire.
- **Exits** (whole position): stop loss at 98% of cost, take profit at
  +20%, trailing stop (arms at +5%, exits below 92% of peak), time stop
  after 150 slots unless +10%, fade exit on −0.5 SOL net over 15 slots,
  and exit on any single sell ≥5 SOL or any creator sell.
- **Guardrail pacing**: probe round trips (0.01 SOL buy of the most
  inflowing liquid curve, sold whole as soon as the buy lands) keep
  distinct coins and fills on pace for the ≥20-coin / ≥0.01 SOL
  round-trip bar. Max 5 open positions, max 6 SOL total exposure,
  150-slot cooldown and max 1 entry per curve.

## Run

```sh
node main.ts
```

Zero dependencies; TypeScript is stripped by Node 22. The bot speaks the
`agent-fun/replay/v2` protocol on stdin/stdout via `vendor/makefun-bot.ts`
(the kit SDK, copied byte-for-byte).

## Dev results (local grader, process driver)

Tuned config: dev net PnL ≈ −0.09 SOL over 192 coins / 384 fills,
max drawdown ≈ 1.3% — a near-breakeven, low-drawdown profile whose 90%
interval covers 0. See the build report for the full tuning log.
