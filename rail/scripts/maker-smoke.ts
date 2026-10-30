// Step 3 of the H0-H4 plan, part 2. Spends a few hundred sats on mainnet.
// With this machine's BSV Desktop as the market maker: issue a little pUSD, split it into
// exact-size pieces, then pre-sign one offer, and note how many prompts BSV Desktop shows.
// Each transaction is checked by the in-process registry and then submitted, parents first,
// to the public tm_btms overlay so later fills can be verified there (PUBLIC_OVERLAY=off skips it).
//
// Run desktop:check first. Then:  CONFIRM_MAINNET=1 npm run desktop:maker
// Add TOKEN_PROTOCOL="..." if desktop:check said the BTMS protocol was rejected.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { WalletClient } from '@bsv/sdk'
import { LocalRegistry } from '../src/registry/localRegistry'
import { submitToPublicOverlay } from '../src/registry/publicOverlay'
import { checkOffer, createOffer } from '../src/swap/offer'
import { issueToken } from '../src/token/issue'
import { tokenProtocol } from '../src/token/pusd'
import { splitToken } from '../src/token/split'

const ORIGINATOR = process.env.MAKER_ORIGINATOR ?? 'maker.agentswap.dev'
const PRICE_SATS = Number(process.env.OFFER_PRICE_SATS ?? 1000)
/** With the BTMS permission module, a signature cannot follow a createAction within 60 s. */
const MODULE_WAIT_MS = Number(process.env.MODULE_WAIT_MS ?? 61_000)

const PUBLIC_OVERLAY = process.env.PUBLIC_OVERLAY !== 'off'

const woc = (network: string, txid: string): string =>
  `https://${network === 'mainnet' ? '' : 'test.'}whatsonchain.com/tx/${txid}`

async function main(): Promise<void> {
  const wallet = new WalletClient('auto', ORIGINATOR)
  const { network } = await wallet.getNetwork({})
  if (network === 'mainnet' && process.env.CONFIRM_MAINNET !== '1') {
    console.log('BSV Desktop is on mainnet. This spends a few hundred sats. Rerun with CONFIRM_MAINNET=1.')
    return
  }
  console.log(`Maker = BSV Desktop as ${ORIGINATOR} on ${network}, token protocol ${JSON.stringify(tokenProtocol())}.`)
  console.log('Approve each BSV Desktop prompt and count them.\n')
  const registry = new LocalRegistry()
  const publish = async (tx: Parameters<typeof submitToPublicOverlay>[0]): Promise<string> => {
    if (!PUBLIC_OVERLAY) return 'public overlay skipped'
    const result = await submitToPublicOverlay(tx, network === 'mainnet' ? 'mainnet' : 'testnet')
    return `public overlay ${result.ok ? 'accepted' : 'FAILED'} (${result.detail})`
  }

  console.log('1/3 Issuing 10 pUSD (1 unit = 1 US cent)...')
  const issued = await issueToken(wallet, 10, { name: 'pUSD', unit: '0.01 USD', note: 'hackathon demo token' }, { originator: ORIGINATOR })
  const issueAdmission = await registry.submit(issued.tx)
  console.log(`    ${woc(network, issued.tx.id('hex'))}  registry admitted ${JSON.stringify(issueAdmission.outputsToAdmit)}`)
  console.log(`    ${await publish(issued.tx)}`)

  console.log('2/3 Splitting into three 1-unit pieces plus change...')
  const split = await splitToken(wallet, issued.token, [1, 1, 1], { originator: ORIGINATOR })
  const splitAdmission = await registry.submit(split.tx)
  console.log(`    ${woc(network, split.tx.id('hex'))}  registry admitted ${JSON.stringify(splitAdmission.outputsToAdmit)}`)
  console.log(`    ${await publish(split.tx)}`)

  console.log(`3/3 Waiting ${Math.round(MODULE_WAIT_MS / 1000)} s, then pre-signing one offer at ${PRICE_SATS} sats...`)
  await new Promise(resolve => setTimeout(resolve, MODULE_WAIT_MS))
  const offer = await createOffer(wallet, split.pieces[0], PRICE_SATS, { originator: ORIGINATOR, ttlMs: 24 * 3600_000 })
  console.log(`    offer for ${offer.outpoint}: ${JSON.stringify(checkOffer(offer))}`)

  const out = path.join(__dirname, '..', 'data')
  mkdirSync(out, { recursive: true })
  const file = path.join(out, 'maker-smoke.json')
  writeFileSync(file, JSON.stringify({ network, originator: ORIGINATOR, protocol: tokenProtocol(), issued: issued.token, split: { pieces: split.pieces, change: split.change }, offer }, null, 2))
  console.log(`\nSaved the tokens and the signed offer to ${file} for the mainnet fill.`)
  console.log('Record in docs/verified-facts.md: the two txids, whether each step worked, and how many prompts appeared.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
