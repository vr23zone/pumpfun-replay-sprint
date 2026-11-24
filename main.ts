// Pump.fun Replay Sprint — paper bot entry point.
// Wires the Snipe + Momentum Pyramid strategy into the make.fun replay
// shim. The shim owns stdin/stdout; diagnostics go to stderr only.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onHello(state) {
    console.error(
      `hello seed=${state.hello.seed} caps=${JSON.stringify(state.hello.caps)} latency=${state.hello.latency_slots}`,
    );
  },
  onBatch(state, batch) {
    return strategy.onBatch(state, batch);
  },
  onDone(state, done) {
    const sol = Number(state.cash) / 1e9;
    console.error(`done reason=${done.reason} batches=${state.seq + 1} cash=${sol.toFixed(4)} SOL`);
    console.error(`stats ${JSON.stringify(strategy.stats())}`);
  },
});
