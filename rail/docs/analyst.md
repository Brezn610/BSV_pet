# The Analyst agent: signed news, paid per call over HTTP 402

The Analyst is a small pay-per-call service the trading agent buys from. One call costs 100 sats on BSV mainnet, paid over HTTP 402 (BRC-121, `@bsv/402-pay` 0.3.3). In return the agent gets the newest post of a whitelisted official X account as an **API3-signed** response, plus a verdict: risk-off, risk-on or ignore, with a one-sentence reason.

It is the "AI agent makes a real payment" part of the BSV track, and it combines all three pieces of the project in one call: authenticated data from API3, an LLM's judgement, and a micropayment on BSV.

## The call

```
GET /verdict/<account>        account ∈ the whitelisted accounts in api3/deployments.json
GET /health                   free: price and accounts
```

- Without payment: `402` with `x-bsv-sats: 100` and `x-bsv-server: <analyst identity key>`. The caller's wallet pays and retries (`create402Fetch`).
- An unknown account gets `404` **before** any payment, so a mistake never costs sats.
- After payment: `200` with

```json
{
  "account": "WhiteHouse",
  "tweetId": "2116235688471650550",
  "text": "…",
  "postedAt": 1793384880,
  "retweet": false,
  "verdict": 0,
  "label": "ignore",
  "reason": "one sentence",
  "judgedBy": "claude | rules",
  "paidSats": 100,
  "txid": "<the BSV payment>",
  "signedBy": { "airnode": "0x7B02…1CCB", "requestHash": "0x783a…95e9", "timestamp": "…", "signature": "0x…" }
}
```

`verdict` uses the same codes as `Verdict` in the API3 TreasuryGuard client (0 ignore, 1 risk-off, 2 risk-on), so the agent can pass it to `submitEvent` unchanged. `tweetId` is a decimal string: tweet ids do not fit in a JavaScript number.

## How it works

1. The paying agent calls `GET /verdict/WhiteHouse`. The 402 middleware asks for 100 sats; the agent's wallet pays with a BRC-29 output and retries; the analyst's server wallet takes the payment in.
2. The analyst buys the account's newest post from the TwitterAPI.io Airnode on AirnodeHub (x402, $0.01 in aUSD on Base Sepolia) and checks the signature against the signer and request hash in `api3/deployments.json`, with the API3 part's own verifier. The same post is served for 60 seconds, so repeated calls do not burn the shared upstream quota.
3. Claude judges the post when `ANTHROPIC_API_KEY` is set (`judgedBy: "claude"`); otherwise, or if Claude fails, keyword rules do (`judgedBy: "rules"`). The post text is treated as untrusted data.
4. The response carries the Airnode signature, so anyone can check that the post was not edited on the way. A signature proves who posted what and when, not that the post is true; TreasuryGuard caps what a news verdict can move (at most 25%).

## On mainnet

The analyst runs from `npm run analyst` behind a public HTTPS tunnel. Two real paid calls, from one of our server wallets acting as the agent:

| Call | Payment |
|---|---|
| `GET /verdict/WhiteHouse` (localhost) | [0be2e9f4…](https://whatsonchain.com/tx/0be2e9f4e61b19bf2f5053723a6be5884fd6fed6d39f45c499b8c74aa948eaa7) |
| `GET /verdict/federalreserve` (through the public HTTPS tunnel) | [f0cc4395…](https://whatsonchain.com/tx/f0cc43959e092dc75c7ea1b1fdae7b7d76402e67c33b42fb8963865ab628adc2) |

## Run it

```sh
cd rail
npm install
npm test                                   # includes the analyst tests, offline
npm run analyst                            # needs API3_PAYER_KEY (aUSD) in rail/.env; creates ANALYST_ROOT_KEY_HEX on first run
cloudflared tunnel --url http://localhost:4402
CONFIRM_MAINNET=1 npm run analyst:pay      # one paid call from a server wallet; ANALYST_URL picks the endpoint
```

The live demo, with fallbacks, is in [demo-analyst.md](./demo-analyst.md).

Settings: `ANALYST_PORT` (default 4402), `ANALYST_PRICE_SATS` (default 100, at most 500), `ANTHROPIC_API_KEY` and `RAIL_MODEL` for Claude. Every paid call is appended to `data/analyst-payments.jsonl` (gitignored).

## Code

| File | What it does |
|---|---|
| `src/analyst/server.ts` | The 402 routes; validation before any charge |
| `src/analyst/api3Post.ts` | The newest signed post of a whitelisted account, verified with the API3 code, cached for 60 s |
| `src/analyst/verdict.ts` | Claude's verdict with a keyword-rule fallback |
| `scripts/analyst-mainnet.ts` | The mainnet server with its own server wallet |
| `scripts/analyst-pay.ts` | One paid call from a server wallet |
| `test/analyst.test.ts`, `test/analystGet.test.ts` | 402, paid answers, replay refused, unknown accounts refused before payment, a real signed post verified and a forged one rejected |

Built during the event, 30 October 2026.
