// The Analyst agent on BSV mainnet: GET /verdict/<account> answers 402 until the caller pays
// ANALYST_PRICE_SATS (default 100) to the analyst's own server wallet, then returns the newest
// API3-signed post of that whitelisted account with an LLM verdict (Claude when ANTHROPIC_API_KEY
// is set, keyword rules otherwise). The signed post is paid with API3_PAYER_KEY (aUSD, x402).
// Every paid call is appended to data/analyst-payments.jsonl. Runs until Ctrl+C.
//
//   npm run analyst            then expose it, e.g.  cloudflared tunnel --url http://localhost:4402
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { api3PostSource, deployedTweetFeeds } from '../src/analyst/api3Post'
import { startAnalyst } from '../src/analyst/server'
import { openServerWallet } from '../src/chain/serverWallet'
import { config } from '../src/config'
import { DATA_DIR, ENV_FILE, loadEnv, requireEnv } from '../src/env'

const PORT = Number(process.env.ANALYST_PORT ?? 4402)
const PRICE_SATS = Number(process.env.ANALYST_PRICE_SATS ?? 100)
const LOG_FILE = path.join(DATA_DIR, 'analyst-payments.jsonl')

/** Creates the analyst's root key in rail/.env (gitignored) on the first run; prints only the identity key. */
function ensureKey(): string {
  const name = 'ANALYST_ROOT_KEY_HEX'
  const existing = process.env[name]
  if (existing !== undefined && existing !== '') return existing
  if (!existsSync(ENV_FILE)) writeFileSync(ENV_FILE, '', { mode: 0o600 })
  const text = readFileSync(ENV_FILE, 'utf8')
  const key = PrivateKey.fromRandom().toHex()
  appendFileSync(ENV_FILE, `${text === '' || text.endsWith('\n') ? '' : '\n'}${name}=${key}\n`)
  return key
}

async function main(): Promise<void> {
  loadEnv()
  if (!Number.isSafeInteger(PRICE_SATS) || PRICE_SATS <= 0 || PRICE_SATS > 500) throw new Error('ANALYST_PRICE_SATS must be 1..500')
  const payerPrivateKey = requireEnv('API3_PAYER_KEY')
  const analyst = await openServerWallet('analyst', ensureKey(), DATA_DIR)
  const accounts = Object.keys(deployedTweetFeeds())
  mkdirSync(DATA_DIR, { recursive: true })

  const running = await startAnalyst(
    {
      wallet: analyst.wallet,
      priceSats: PRICE_SATS,
      accounts,
      postSource: api3PostSource({ payerPrivateKey }),
      onPaid: entry => {
        const line = { at: new Date().toISOString(), ...entry }
        appendFileSync(LOG_FILE, JSON.stringify(line) + '\n')
        console.log(`paid ${entry.satoshisPaid ?? '?'} sats for ${entry.path} · ${entry.verdict.label} (${entry.verdict.judgedBy})${entry.txid === undefined ? '' : ` · https://whatsonchain.com/tx/${entry.txid}`}`)
      }
    },
    PORT
  )

  console.log(`Analyst identity ${analyst.identityKey}, balance ${await analyst.wallet.balance()} sats`)
  console.log(`Listening on ${running.url}: GET /verdict/<${accounts.join('|')}> for ${PRICE_SATS} sats`)
  console.log(`Judge: ${config.claude.enabled ? `Claude (${config.claude.model})` : 'keyword rules (set ANTHROPIC_API_KEY for Claude)'}`)
  console.log('Ctrl+C to stop.')

  const stop = async (): Promise<void> => {
    await running.close()
    await analyst.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
}

main().catch(err => {
  console.error((err as Error).message)
  process.exit(1)
})
