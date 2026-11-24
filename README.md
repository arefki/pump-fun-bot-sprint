# pump-fun-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/arefki/pump-fun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/arefki/pump-fun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A Solana paper-trading bot for pump.fun bonding curves. It snipes fresh coins on confirmed early buy flow (2 SOL of buys across 3+ trades within 100 slots of creation), scales in toward 0.3 SOL per position as the reserve cap allows, and exits on a ladder: half at +50%, the rest at +120%, with a trailing stop, a -25% stop-loss, and a 900-slot time exit. Fully deterministic — every decision comes from the event stream alone, all ratios compared with bigint math, so two runs on the same replay produce the same action log.

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
