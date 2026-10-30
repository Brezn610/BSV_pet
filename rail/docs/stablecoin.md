# pUSD: a BSV-collateralized stablecoin for AI agents

pUSD is a dollar stablecoin that lives on BSV and is backed by BSV locked as collateral, in the style of DAI. An owner locks BSV, takes pUSD against it, and gives it to their AI agent as a stable budget. The price that decides how much pUSD a position may take, and when it is liquidated, is a signed API3 price. There is no bridge: the stablecoin, the collateral, the payments and the liquidations are all on BSV.

## Usage and value note

**The problem.** AI agents are starting to pay for data, APIs and compute on their own, in amounts far below a cent. BSV makes those payments cheap, but an agent's owner thinks in dollars, and BSV has no stablecoin agents can hold and pay with. Bringing one in from another chain means a bridge, which is the most attacked piece of infrastructure in crypto and too large to build safely here.

**Target users.**
- Teams and platforms that run AI agents and want to give each agent a budget in dollars, not in a volatile coin.
- BSV holders who want dollar liquidity without selling their BSV.
- Liquidators and market makers, who earn the liquidation bonus and the spread.

**How people use it.**
1. The owner locks BSV in a collateral vault from BSV Desktop.
2. The owner signs a mint request in their wallet and receives up to 66% of the collateral's value in pUSD.
3. The owner hands the pUSD to their agent, which pays services with it (or with sats, over HTTP 402).
4. The owner repays the pUSD to get the collateral back. If the signed price pushes the position to 75% loan-to-value instead, a liquidator repays the debt and the owner gets the rest of the collateral back, all in one transaction.

**What it brings to BSV.**
- Stable value created on BSV, from BSV, without a bridge: exactly the "stable value to pay with" the track lists as missing for agents.
- A reason to hold BSV: collateral stays locked on BSV while its owner uses its dollar value.
- Liquidity that originates and stays on BSV: every mint, payment, repayment and liquidation is a BSV transaction.

## How it works

| Step | What happens | Rule |
|---|---|---|
| Lock | The owner locks BSV in a collateral output | `IF <owner> CHECKSIGVERIFY ELSE <liquidator> CHECKSIGVERIFY ENDIF <watcher> CHECKSIG` |
| Mint | The reserve sends pUSD to the owner | at most 66% loan-to-value, owner's signed request, price at most 60 s old |
| Repay | The owner sends pUSD back to the reserve | collateral is released only once the whole debt is repaid |
| Liquidate | One BSV transaction: pUSD back to the reserve, the owner's share out of the collateral, the rest to the liquidator | at 75% loan-to-value; the liquidator gets at most the debt plus 5% |

Example (from the tests): 5 BSV at $20 is $100 of collateral. The owner mints 60 pUSD (60% LTV). At $16 the collateral is worth $80 and the position reaches 75%: the liquidator repays 60 pUSD, receives $63 of BSV, and the owner gets $17 of BSV back.

**One supply.** BTMS tokens cannot be minted again after their issuance, so pUSD is issued once into a reserve. Minting is a transfer out of the reserve; repaying and liquidating are transfers back. pUSD in circulation is the issued total minus what the reserve holds, and the end-to-end demo checks that it always equals the open debt in the position book.

**The price.** The book, the liquidator bot and the watcher use the same signed CoinPaprika BSV/USD response that the TreasuryGuard contract on Base Sepolia accepts: bought over x402 in aUSD, checked against the signer and request hash in the API3 part's `deployments.json`, and converted exactly to 8 decimals. Data that is much older than its signature is refused.

## Trust assumptions (stated openly)

- **The watcher is a trust point.** BSV script cannot see the debt or the price, so the rules are enforced by the watcher's co-signature: it signs only what the position book allows, over the exact outputs. It can refuse; while it refuses, the collateral stays where it is. Roadmap: k-of-n watchers.
- **The reserve holder is a trust point.** The team holds the pUSD reserve in this demo.
- **The peg is backed, not traded.** Every pUSD in circulation is backed by locked BSV, but nobody redeems pUSD at $1 yet, and the team is the only liquidity provider.
- **No bad-debt backstop.** If the collateral falls below the debt plus bonus before liquidation, the liquidator takes all of it and the shortfall is reported; pUSD holders bear it.
- **Demo threshold.** A real price will not fall 12% during a two-minute demo, so the live demo lowers the liquidation threshold publicly and says so up front.
- **Signed is not true.** An API3 signature proves who published the price and when, not that the market price is right.

## Code

All in `rail/`, TypeScript on the BSV TypeScript stack (`@bsv/sdk`, `@bsv/wallet-toolbox`, `@bsv/btms`).

| File | What it does |
|---|---|
| `src/cdp/math.ts` | Loan-to-value, mint ceiling, liquidation price and split, in the API3 client's units |
| `src/cdp/positions.ts` | The position book: open, mint, repay, close, liquidate, price freshness |
| `src/cdp/reserve.ts` | Issue the pUSD reserve once; mint and repay as BTMS transfers |
| `src/cdp/collateral.ts` | The collateral vault: lock, withdraw, atomic liquidation, the watcher's liquidation check |
| `src/cdp/authorize.ts` | The owner's signed mint request, verified by the watcher (expiry, replay) |
| `src/cdp/liquidator.ts` | The liquidator bot: one JSON log line per cycle, dry run until the contract's liquidation intent is wired in |
| `src/cdp/api3Price.ts` | The signed API3 BSV/USD price, verified with the API3 part's own code |
| `src/analyst/` | The Analyst agent: a pay-per-call service over HTTP 402 that the agent pays in sats |
| `scripts/cdp-demo.ts` | The whole story on the offline chain, in ten steps |

## Run it

Node.js 22 or newer.

```sh
cd rail
npm install
npm test            # offline, mock chain: all rail tests, including the stablecoin and analyst tests
npm run typecheck
npm run demo:cdp    # the ten-step story: reserve, lock, mint, agent payment, price drop, liquidation
```

The API3 price tests need the team repo's `api3` branch with its dependencies installed. They look for it next to this repo (`../api3-branch/api3`); set `API3_DIR` if it is elsewhere, otherwise they are skipped.

For a live, paid price, put the agent's Base Sepolia key (it pays $0.001 in aUSD per call) in `rail/.env`, which is gitignored:

```sh
API3_PAYER_KEY=0x...
npm run price:api3
```

## What is real and what is not yet

- **Real and tested:** every rule above, on the wallet toolbox's offline chain with the official BTMS admission rules, and the API3 signature check on a real signed CoinPaprika response.
- **Not yet:** a run on BSV mainnet with BSV Desktop, the live x402 price call, and the contract's mint and liquidation intents on Base Sepolia. Until those are wired in, the position book applies the same rules on the BSV side.
- **Built during the event:** everything in this document was written on 30 October 2026, during the hackathon.
