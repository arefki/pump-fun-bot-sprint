# pump-fun-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/arefki/pump-fun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/arefki/pump-fun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A Solana paper-trading bot for pump.fun bonding curves. It buys the coins that rocket to 40 SOL of real reserve within 500 slots of creation — the fast risers that have already proven explosive demand — with one full-size entry of 0.35 SOL, then holds for a 2x take-profit or cuts at a -30% stop-loss (20,000-slot time exit). Calibrated on the dev window: early-momentum, dip-buying, and no-take-profit variants all lose after the 2-slot fill latency and ~2.6% round-trip fees, while this late-momentum shape is the only one that beats holding cash (+0.76 SOL net on dev, 33 coins, 36% win rate). Fully deterministic — every decision comes from the event stream alone, all ratios compared with bigint math, so two runs on the same replay produce the same action log.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (the make.fun replay harness feeds it market events and it answers with orders). To grade it on the dev window:

```sh
node kit/cli/makefun.mjs grade-local --kit kit --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
