# Live demo: the Analyst agent (checklist)

What the jury sees in about 60 seconds: an AI agent pays the Analyst 100 sats on BSV mainnet over HTTP 402, gets an API3-signed post and a verdict back, and the payment is on WhatsOnChain.

## Before the slot (10 minutes ahead)

- [ ] The laptop is on power, and sleep is set to "Never".
- [ ] The analyst server is running (`npm run analyst` in `rail/`), and the tunnel is running (`cloudflared tunnel --url http://localhost:4402`).
- [ ] `curl https://<tunnel>/health` returns `{"ok":true,"priceSats":100,...}`.
- [ ] `curl -i https://<tunnel>/verdict/WhiteHouse` returns `402` with `x-bsv-sats: 100`.
- [ ] The paying wallet has at least 1,000 sats. A rehearsal call (`CONFIRM_MAINNET=1 npm run analyst:pay`) prints the balance before and after.
- [ ] If Claude is meant to judge: `ANTHROPIC_API_KEY` is in `rail/.env`, the server was restarted after it was added, and one paid call returned `"judgedBy": "claude"`.
- [ ] These tabs are open: WhatsOnChain (with the two earlier payments, as a fallback), `rail/docs/analyst.md`, and a terminal in `rail/`.

## The demo

1. Show `GET /verdict/WhiteHouse` without payment: `402`, the price is 100 sats, and the server's identity key is in the headers.
2. Run the paid call:
   ```sh
   ANALYST_URL=https://<tunnel>/verdict/WhiteHouse CONFIRM_MAINNET=1 npm run analyst:pay
   ```
   Or let the trading agent make the call.
3. Point at the response:
   - `text`: the real post.
   - `verdict` and `reason`: the agent's input.
   - `signedBy.airnode` and `signature`: API3 signed it.
   - `paidSats: 100` and `txid`.
4. Open the `txid` on WhatsOnChain. It is a real mainnet payment, a few seconds old.
5. One line on the trust model: the signature proves who posted what and when, not that the post is true. TreasuryGuard caps what a news verdict can move (at most 25%).

## If something fails

| Symptom | Fallback |
|---|---|
| The tunnel is down or its URL changed | Restart `cloudflared` and use the new URL, or demo on `http://localhost:4402`. |
| `502` from the analyst | The AirnodeHub or x402 upstream is down. Show the two recorded mainnet payments in `analyst.md`, then rerun later. |
| Claude errors or is slow | The server falls back to keyword rules by itself (`judgedBy: "rules"`), so the call still succeeds. |
| The payer has too few sats | Use `ANALYST_PAYER=cdp-reserve`, or top up the payer from BSV Desktop. |
| No network | Run `npm test`: the analyst tests show 402, payment, replay refused and signature checks offline. |

Never show `rail/.env` on screen.
