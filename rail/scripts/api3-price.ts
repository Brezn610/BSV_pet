// Fetches one live, paid, verified BSV/USD price from API3 (x402, $0.001 in aUSD on Base Sepolia)
// and prints it as the position book sees it.
//
//   API3_PAYER_KEY=0x… in rail/.env (the agent's Base Sepolia key, with aUSD), then:
//   npm run price:api3
import { api3Dir, api3PriceSource } from '../src/cdp/api3Price'
import { loadEnv } from '../src/env'

async function main(): Promise<void> {
  loadEnv()
  const payerPrivateKey = process.env.API3_PAYER_KEY
  if (payerPrivateKey === undefined || payerPrivateKey === '') {
    throw new Error('API3_PAYER_KEY is not set in rail/.env: the agent key that pays x402 in aUSD on Base Sepolia')
  }
  const price = await api3PriceSource({ payerPrivateKey }).latest()
  const age = Math.floor(Date.now() / 1000) - price.signedAt
  console.log(`API3 code:  ${api3Dir()}`)
  console.log(`BSV/USD:    $${(Number(price.value) / 1e8).toFixed(8)} (${price.value} with 8 decimals)`)
  console.log(`1 h change: ${(Number(price.change1hBps) / 100).toFixed(2)} %`)
  console.log(`signed:     ${new Date(price.signedAt * 1000).toISOString()} (${age} s ago), data updated ${new Date(price.updatedAt * 1000).toISOString()}`)
  console.log(`signer:     ${price.response.airnode} ✓ matches deployments.json`)
}

main().catch(err => {
  console.error((err as Error).message)
  process.exit(1)
})
