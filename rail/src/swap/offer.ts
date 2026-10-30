// Offers: the market maker's half of a swap. The maker signs its own pUSD input with
// SIGHASH_SINGLE | ANYONECANPAY | FORKID, which commits only to that input and to output 0
// ("pay me N sats"). Anyone may complete the rest of the transaction; nobody can change output 0.
import {
  Beef,
  Hash,
  LockingScript,
  P2PKH,
  PushDrop,
  Script,
  Spend,
  Transaction,
  UnlockingScript,
  Utils,
  type WalletInterface,
  type WalletProtocol
} from '@bsv/sdk'
import type { OwnedToken } from '../token/split'
import { decodeToken, randomDerivation, tokenProtocol } from '../token/pusd'

/** BRC-29 payment protocol, used so the maker's wallet can internalize the sats it is paid. */
const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']

export interface SignedOffer {
  /** The maker's exact-size pUSD token. Always input 0 of the fill. */
  outpoint: string
  assetId: string
  amount: number
  metadata?: string
  /** What the maker is paid, in output 0 of the fill. */
  priceSats: number
  payLockingScript: string
  /** The maker's SINGLE|ANYONECANPAY unlocking script for input 0. */
  unlockingScript: string
  /** BEEF with the token's source transaction, for the taker's `inputBEEF`. */
  beef: number[]
  remittance: { derivationPrefix: string; derivationSuffix: string }
  expiresAt: number
}

function sourceTransaction(beef: number[], outpoint: string): { tx: Transaction; vout: number } {
  const [txid, vout] = outpoint.split('.')
  const tx = Beef.fromBinary(beef).findAtomicTransaction(txid)
  if (tx === undefined) throw new Error(`Offer BEEF does not contain ${txid}`)
  return { tx, vout: Number(vout) }
}

/** Maker side. `wallet` can be BSV Desktop through WalletClient, or a wallet-toolbox Wallet. */
export async function createOffer(
  wallet: WalletInterface,
  token: OwnedToken,
  priceSats: number,
  options: { ttlMs?: number; protocol?: WalletProtocol; originator?: string } = {}
): Promise<SignedOffer> {
  if (!Number.isSafeInteger(priceSats) || priceSats <= 0) throw new Error(`Invalid price ${priceSats}`)
  const protocol = options.protocol ?? tokenProtocol()
  const { tx: source, vout } = sourceTransaction(token.beef, token.outpoint)

  // Output 0 pays the maker through a BRC-29 key, so its wallet can internalize the payment.
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true }, options.originator)
  const remittance = { derivationPrefix: randomDerivation(), derivationSuffix: randomDerivation() }
  const { publicKey: payKey } = await wallet.getPublicKey(
    {
      protocolID: BRC29_PROTOCOL,
      keyID: `${remittance.derivationPrefix} ${remittance.derivationSuffix}`,
      counterparty: identityKey
    },
    options.originator
  )
  const payLock = new P2PKH().lock(Hash.hash160(Utils.toArray(payKey, 'hex')))

  const half = new Transaction(1, [], [], 0)
  half.addInput({ sourceTransaction: source, sourceOutputIndex: vout, sequence: 0xffffffff, unlockingScript: new Script() })
  half.addOutput({ satoshis: priceSats, lockingScript: payLock })
  // Rule 2: with no output at the input's index the signature would cover no outputs at all.
  if (half.outputs.length !== 1) throw new Error('Output 0 must be in place before the maker signs')

  const unlocker = new PushDrop(wallet, options.originator).unlock(protocol, token.keyID, 'self', 'single', true)
  const unlockingScript = await unlocker.sign(half, 0)
  return {
    outpoint: token.outpoint,
    assetId: token.assetId,
    amount: token.amount,
    metadata: token.metadata,
    priceSats,
    payLockingScript: payLock.toHex(),
    unlockingScript: unlockingScript.toHex(),
    beef: token.beef,
    remittance,
    expiresAt: Date.now() + (options.ttlMs ?? 10 * 60_000)
  }
}

export type OfferCheck = { ok: true } | { ok: false; reason: string }

/**
 * Taker side, before signing anything: the offered output really is the pUSD it claims to be,
 * and the maker's signature validates against output 0 as the taker will build it.
 * Whether the token is admitted and unspent is the registry's call (guardian rule).
 */
export function checkOffer(offer: SignedOffer, now = Date.now()): OfferCheck {
  if (now > offer.expiresAt) return { ok: false, reason: 'Offer has expired' }
  let source: Transaction
  let vout: number
  try {
    ;({ tx: source, vout } = sourceTransaction(offer.beef, offer.outpoint))
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
  const output = source.outputs[vout]
  if (output === undefined) return { ok: false, reason: 'Offer outpoint does not exist' }
  if (output.satoshis !== 1) return { ok: false, reason: 'Token output must hold exactly 1 sat' }
  const token = decodeToken(output.lockingScript.toHex())
  if (token === undefined) return { ok: false, reason: 'Offered output is not a pUSD token' }
  if (token.assetId !== offer.assetId || token.amount !== offer.amount || token.metadata !== offer.metadata) {
    return { ok: false, reason: 'Offer does not match the token it points at' }
  }
  try {
    const valid = new Spend({
      sourceTXID: source.id('hex'),
      sourceOutputIndex: vout,
      sourceSatoshis: 1,
      lockingScript: output.lockingScript,
      transactionVersion: 1,
      otherInputs: [],
      outputs: [{ satoshis: offer.priceSats, lockingScript: LockingScript.fromHex(offer.payLockingScript) }],
      unlockingScript: UnlockingScript.fromHex(offer.unlockingScript),
      inputSequence: 0xffffffff,
      inputIndex: 0,
      lockTime: 0
    }).validate()
    return valid ? { ok: true } : { ok: false, reason: 'Maker signature does not validate' }
  } catch (err) {
    return { ok: false, reason: `Maker signature does not validate: ${(err as Error).message}` }
  }
}

/** Maker side, after a fill: take the sats in output 0 into the maker's wallet. */
export async function collectProceeds(
  wallet: WalletInterface,
  offer: SignedOffer,
  fillAtomicBeef: number[],
  options: { originator?: string } = {}
): Promise<void> {
  const fill = Transaction.fromAtomicBEEF(fillAtomicBeef)
  const outputIndex = fill.outputs.findIndex(o => o.lockingScript.toHex() === offer.payLockingScript)
  if (outputIndex === -1 || fill.outputs[outputIndex].satoshis !== offer.priceSats) {
    throw new Error('Fill does not pay this offer')
  }
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true }, options.originator)
  await wallet.internalizeAction(
    {
      tx: fillAtomicBeef,
      description: 'pUSD offer filled',
      outputs: [{ outputIndex, protocol: 'wallet payment', paymentRemittance: { ...offer.remittance, senderIdentityKey: identityKey } }]
    },
    options.originator
  )
}
