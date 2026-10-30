// Pays the Analyst once over HTTP 402 from one of our mainnet server wallets (default: the CDP
// liquidator, which holds sats), the same way a trading agent would. Needs CONFIRM_MAINNET=1.
//
//   CONFIRM_MAINNET=1 npm run analyst:pay
//   ANALYST_URL=https://<tunnel>/verdict/WhiteHouse CONFIRM_MAINNET=1 npm run analyst:pay
import { create402Fetch } from '@bsv/402-pay/client'
import { openServerWallet } from '../src/chain/serverWallet'
import { DATA_DIR, loadEnv, requireEnv } from '../src/env'
import { bindOriginator } from '../src/wallet/agentWallet'

const URL_TO_PAY = process.env.ANALYST_URL ?? 'http://localhost:4402/verdict/WhiteHouse'
const PAYER = process.env.ANALYST_PAYER ?? 'cdp-liquidator'
const PAYER_KEYS: Record<string, string> = { 'cdp-liquidator': 'CDP_LIQUIDATOR_ROOT_KEY_HEX', 'cdp-reserve': 'CDP_RESERVE_ROOT_KEY_HEX' }

async function main(): Promise<void> {
  loadEnv()
  const keyName = PAYER_KEYS[PAYER]
  if (keyName === undefined) throw new Error(`ANALYST_PAYER must be one of ${Object.keys(PAYER_KEYS).join(', ')}`)
  if (process.env.CONFIRM_MAINNET !== '1') {
    console.log(`Would pay ${URL_TO_PAY} from ${PAYER} on BSV mainnet. Rerun with CONFIRM_MAINNET=1 to do it.`)
    return
  }
  const payer = await openServerWallet(PAYER, requireEnv(keyName), DATA_DIR)
  try {
    const before = await payer.wallet.balance()
    const fetch402 = create402Fetch({ wallet: bindOriginator(payer.wallet, 'agent.treasury-guard.dev') })
    const res = await fetch402(URL_TO_PAY)
    console.log(`HTTP ${res.status}`)
    console.log(JSON.stringify(await res.json(), null, 2))
    console.log(`${PAYER} balance ${before} → ${await payer.wallet.balance()} sats`)
  } finally {
    await payer.close()
  }
}

main().catch(err => {
  console.error((err as Error).message)
  process.exit(1)
})
