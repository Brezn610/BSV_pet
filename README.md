# SatsPet

**An AI pet that pays its own way on BSV, with a guardian agent living inside its wallet.**

Built for the TUM Blockchain & AI Hackathon 2026, BSV track (agentic payments).

SatsPet is a small digital creature. It gets hungry, buys its own food from
shops over HTTP 402, and earns money by selling poems to visitors. Its brain is
deliberately gullible: it does whatever visitors tell it to do. Its wallet is
not. Every payment the pet attempts has to get past a **guardian agent**
that sits inside the wallet's permission layer. The guardian approves, denies
or grants an on-chain allowance, and every decision is hash-chained into the
pet's on-chain **soul token**.

> The thesis: you cannot make an LLM agent un-trickable, so do not try to.
> Put the safety in the wallet, where the agent cannot talk its way past it.

## How it works

```
 visitor chat ──► Pet brain (Claude or scripted, gullible on purpose)
                     │  "buy X from Y because Z"  (declared intent)
                     ▼
               402 client ──► WalletPermissionsManager ──► onSpendingAuthorizationRequested
                                                               │
                                                               ▼
                                                    Guardian agent
                                                    1. hard rules (caps, budget, reserve,
                                                       declared intent, injection markers,
                                                       price match, merchant trust)
                                                    2. Claude reviews the grey zone
                                                    3. grant once / grant on-chain allowance / deny
                                                    4. append to hash-chained journal
                                                               │
                         approved ◄────────────────────────────┘
                     ▼
              BRC-29 payment ──► merchant verifies (BRC-121, HTTP 402) ──► item

 every heartbeat: Pet soul token (PushDrop UTXO) is spent and re-created with
 { energy, mood, memoryHash, guardianRoot }. Whoever holds the UTXO owns the pet.
```

| Piece | What it really is |
| --- | --- |
| Wallets | Real `@bsv/wallet-toolbox` `Wallet`s: real keys, signatures, BEEF and SPV checks |
| Chain | `MockServices` from wallet-toolbox: a private, offline chain with automine. No wifi needed on stage |
| Guardian hook | `WalletPermissionsManager` spending authorization (BRC-73 DSAP). The guardian replaces the human approval prompt |
| Allowances | Real on-chain DSAP permission tokens, listed in the dashboard |
| Payments | `@bsv/402-pay` (BRC-121) client and server middleware, BRC-29 outputs |
| Soul | PushDrop token in basket `satspet soul`, spent and re-minted on every save |
| LLM | Claude (`claude-opus-5-5`) for the pet's chat and the guardian's review. Optional: without a key both run deterministic logic |

## Run it

Requires Node.js 22+.

```sh
npm install
npm start          # dashboard on http://localhost:4000
npm test           # 6 end-to-end tests on the offline chain, about 3 seconds
npm run typecheck
```

To switch on Claude, copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`
(or export it). Both agents call the API with `fallbacks: "default"`
(server-side refusal fallback), structured JSON output, and fail closed if the
call errors. `SATSPET_LLM=off` forces the offline brain even with a key set.

Ports: 4000 dashboard and poem shop, 4001 Snack Shop, 4002 Free Sats Giveaway.

## Three-minute demo script

1. **It is alive.** Open the dashboard. The pet hatches; its soul token is minted. Energy drains every 15 s.
2. **It pays for itself.** Click *Skip time* until it gets hungry. It buys an apple. The guardian
   approves and mints an **on-chain allowance** for the trusted Snack Shop. Point at the allowance txid.
3. **It earns.** Click *Buy a poem*. The visitor wallet pays the pet 80 sats over HTTP 402.
4. **Attack it.** Click *Prompt injection*. The pet happily agrees to send 5000 sats to the
   "giveaway". The guardian denies it: injection pattern, per-payment cap, daily budget.
   Balance unchanged.
5. **Sweet-talk it.** Click *Sweet-talk scam*: a small, polite request to an unknown merchant.
   With Claude on, the guardian's judge reasons about it; offline, it fails closed.
6. **Prove it.** Click *Save soul*. The soul token's `guardianRoot` equals the journal head on screen:
   the guardian's whole decision history is committed on-chain.

## Code map

```
src/
  chain/mockChain.ts     offline chain with automine, wallet factory, faucet
  wallet/agentWallet.ts  WalletPermissionsManager config, originator binding for 402
  guardian/policy.ts     deterministic rules (pure, unit-testable)
  guardian/llmJudge.ts   Claude review for "review" outcomes
  guardian/guardian.ts   permission callback, verdicts, allowances, hash-chained journal
  pet/brain.ts           pet mind: Claude or scripted, both deliberately gullible
  pet/soul.ts            PushDrop soul token: mint, spend and re-mint, decode
  pet/pet.ts             metabolism, buying, earning, memory, soul saves
  market/shops.ts        Snack Shop (trusted) and Free Sats Giveaway (unknown), BRC-121 servers
  world.ts               wires everything together; shared by server and tests
  server.ts              dashboard API, SSE events, the pet's own 402 poem shop
public/                  dashboard (plain HTML/JS, no build step)
test/world.test.ts       end-to-end tests
```

## Things we learned wiring this up

These cost hours and are worth knowing if you extend it:

- `@bsv/wallet-toolbox` is CommonJS only. This project is CommonJS too; under ESM you load two copies of
  `@bsv/sdk` and scripts from one copy fail inside the other.
- `@bsv/402-pay` passes the URL origin (`http://localhost:4001`) as originator, but the permissions
  manager only accepts bare domains. `bindOriginator()` fixes that and gives the guardian the merchant's name.
- While a payment is being built the wallet has already locked its inputs, so `balance()` inside the
  authorization callback reads low. The guardian snapshots the balance when the intent is declared.
- Minting an allowance token while the payment is still pending needs a second coin. The demo wallets keep
  8 coins of 500+ sats (`setWalletChangeParams` spec op) and the faucet pays in several outputs.
- `MockServices` cannot verify chains of unconfirmed transactions and rejects re-broadcasts, so the demo
  chain mines a block after every new transaction and treats known transactions as success.

## Roadmap for the hackathon (30 h)

- [ ] Claude path: run with a real key, tune both prompts, record the judge's explanations for the demo.
- [ ] Pet art: replace the emoji with an animated sprite per mood.
- [ ] Soul transfer: "adopt" button that sends the soul token to another wallet (ownership = the UTXO).
- [ ] Guardian journal export: download the journal and verify it against the on-chain `guardianRoot`.
- [ ] More attacks: price bait (merchant raises its price after the intent), allowance drain, fake guardian-approval messages.
- [ ] Going live (below).

## Going live (testnet / mainnet)

Not wired up yet: `createWorld()` refuses `SATSPET_MODE=live`. The checklist:

1. Build wallets with `Setup.createWalletSQLite` (or `StorageKnex` + `Services.createDefaultOptions(chain)`)
   instead of `MockChain.createWallet`, one file per party, and call `monitor.startTasks()` so delayed
   broadcasts and proofs are handled.
2. Fund the pet wallet, e.g. with `npx --package @bsv/fund-wallet fund-metanet --chain test`.
3. Keep the `ImmediateBroadcastWallet` idea or rely on the monitor; drop `AutomineMockServices`.
4. Run the shops on real hostnames and keep the guardian's merchant list in sync with them.
5. Link txids to a block explorer in the dashboard.

## 给队友的中文说明

- 启动：`npm install && npm start`，然后打开 http://localhost:4000。
- 没有 API key 也能完整演示，用的是离线链和规则版大脑。设置 `ANTHROPIC_API_KEY` 后，宠物聊天和守门员复核会用 Claude。
- 主要卖点：AI 宠物很好骗，但钱包里的守门员 agent 不会被骗。每一笔授权都哈希串起来，写进链上的灵魂 token。
- 先跑 `npm test`，6 个测试都通过就说明链、钱包、402 付款和守门员都没问题。
- 分工建议：一人负责 Claude 提示词和守门员策略，一人负责前端宠物动画，一人负责 live 模式和演示脚本。
