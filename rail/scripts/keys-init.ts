// Step 4 setup. Creates rail/.env (gitignored) with fresh root keys for the agent's and the
// merchant's mainnet server wallets, unless they are already there. Prints public keys only.
// Run from rail/:  npm run keys:init
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { PrivateKey } from '@bsv/sdk'
import { ENV_FILE, loadEnv } from '../src/env'

const KEYS = ['AGENT_ROOT_KEY_HEX', 'MERCHANT_ROOT_KEY_HEX']

function main(): void {
  loadEnv()
  if (!existsSync(ENV_FILE)) writeFileSync(ENV_FILE, '', { mode: 0o600 })
  const text = readFileSync(ENV_FILE, 'utf8')
  for (const name of KEYS) {
    const existing = process.env[name]
    if (existing !== undefined && existing !== '') {
      console.log(`${name} already set; identity key ${PrivateKey.fromHex(existing).toPublicKey().toString()}`)
      continue
    }
    const key = PrivateKey.fromRandom()
    appendFileSync(ENV_FILE, `${text === '' || text.endsWith('\n') ? '' : '\n'}${name}=${key.toHex()}\n`)
    console.log(`${name} created; identity key ${key.toPublicKey().toString()}`)
  }
  chmodSync(ENV_FILE, 0o600)
  console.log(`\nKeys are in ${ENV_FILE}. Never commit, paste or share that file. Back it up if the wallets hold money.`)
}

main()
