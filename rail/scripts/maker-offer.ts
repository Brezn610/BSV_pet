// Pre-signs a new offer with BSV Desktop from the next unused pUSD piece that desktop:maker
// split off, and makes it the offer agent:fill takes next. Spends nothing; BSV Desktop may
// ask once to approve the signature.
// Run from rail/:  npm run desktop:offer   (OFFER_PRICE_SATS changes the price)
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { WalletClient } from '@bsv/sdk'
import { DATA_DIR } from '../src/env'
import { checkOffer, createOffer, type SignedOffer } from '../src/swap/offer'
import type { OwnedToken } from '../src/token/split'

const PRICE_SATS = Number(process.env.OFFER_PRICE_SATS ?? 1000)
const MAKER_FILE = path.join(DATA_DIR, 'maker-smoke.json')

interface MakerFile {
  originator: string
  split: { pieces: OwnedToken[] }
  offer: SignedOffer
  /** Pieces that already had an offer, oldest first. */
  offeredPieces?: string[]
}

async function main(): Promise<void> {
  const saved = JSON.parse(readFileSync(MAKER_FILE, 'utf8')) as MakerFile
  const offered = new Set([...(saved.offeredPieces ?? []), saved.offer.outpoint])
  const piece = saved.split.pieces.find(p => !offered.has(p.outpoint))
  if (piece === undefined) throw new Error('Every piece already has an offer. Run desktop:maker for new pUSD.')

  console.log(`Pre-signing an offer for ${piece.outpoint} at ${PRICE_SATS} sats; approve BSV Desktop if it asks...`)
  const offer = await createOffer(new WalletClient('auto', saved.originator), piece, PRICE_SATS, {
    originator: saved.originator,
    ttlMs: 24 * 3600_000
  })
  const check = checkOffer(offer)
  if (!check.ok) throw new Error(`The new offer does not validate: ${check.reason}`)
  writeFileSync(MAKER_FILE, JSON.stringify({ ...saved, offer, offeredPieces: [...offered] }, null, 2))
  console.log(`Saved. ${saved.split.pieces.length - offered.size - 1} unused piece(s) left. Next: CONFIRM_MAINNET=1 npm run agent:fill`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
