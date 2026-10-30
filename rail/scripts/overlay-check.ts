// After desktop:maker: resubmit the saved issuance and split to the public tm_btms overlay
// with the legacy X-Topics fix, then look each token output up through ls_btms.
// Free. Run from rail/:  npm run overlay:check
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Transaction } from '@bsv/sdk'
import { isOnPublicOverlay, submitToPublicOverlay } from '../src/registry/publicOverlay'

const file = process.argv[2] ?? path.join(__dirname, '..', 'data', 'maker-smoke.json')

async function main(): Promise<void> {
  const saved = JSON.parse(readFileSync(file, 'utf8')) as {
    issued: { beef: number[]; outpoint: string }
    split: { pieces: Array<{ beef: number[]; outpoint: string }>; change?: { outpoint: string } }
  }
  for (const [name, beef] of [['issuance', saved.issued.beef], ['split', saved.split.pieces[0].beef]] as const) {
    const tx = Transaction.fromAtomicBEEF(beef)
    const result = await submitToPublicOverlay(tx, 'mainnet')
    console.log(`submit ${name} ${tx.id('hex')}: ${result.ok ? 'accepted' : 'FAILED'} (${result.detail})`)
  }
  const outpoints = [saved.issued.outpoint, ...saved.split.pieces.map(p => p.outpoint), ...(saved.split.change ? [saved.split.change.outpoint] : [])]
  for (const outpoint of outpoints) {
    console.log(`ls_btms ${outpoint}: ${(await isOnPublicOverlay(outpoint, 'mainnet')) ? 'found' : 'not found'}`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
