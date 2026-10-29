// Taker side: complete a maker's offer in one transaction that pays the maker in sats and
// sends the pUSD straight to the merchant. The agent never holds the pUSD.
import { Beef, LockingScript, Transaction, UnlockingScript, type WalletInterface } from '@bsv/sdk'
import type { Admission, LocalRegistry } from '../registry/localRegistry'
import { bytes } from '../token/pusd'
import type { SignedOffer } from './offer'

/**
 * Guardian pre-check, before anything is signed: would the registry admit the merchant's
 * pUSD output of this fill? A wrong asset ID, amount or metadata still mines but burns the
 * token, and the agent pays the maker for nothing (risk R16). Only token inputs and outputs
 * matter to the registry, so the agent's own funding inputs are left out of the preview.
 */
export async function previewFill(
  offer: SignedOffer,
  merchantLockingScript: string,
  registry: LocalRegistry
): Promise<{ merchantOutputAdmitted: boolean; admission: Admission }> {
  const [txid, vout] = offer.outpoint.split('.')
  const source = Beef.fromBinary(offer.beef).findAtomicTransaction(txid)
  if (source === undefined) throw new Error(`Offer BEEF does not contain ${txid}`)
  const draft = new Transaction(1, [], [], 0)
  draft.addInput({
    sourceTransaction: source,
    sourceOutputIndex: Number(vout),
    sequence: 0xffffffff,
    unlockingScript: UnlockingScript.fromHex(offer.unlockingScript)
  })
  draft.addOutput({ satoshis: offer.priceSats, lockingScript: LockingScript.fromHex(offer.payLockingScript) })
  draft.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(merchantLockingScript) })
  const admission = await registry.preview(draft)
  return { merchantOutputAdmitted: admission.outputsToAdmit.includes(1), admission }
}

export interface Fill {
  txid: string
  /** AtomicBEEF of the fill: what the agent hands to the merchant. */
  atomicBeef: number[]
  tx: Transaction
}

/**
 * `wallet` should be the agent's guarded wallet (a WalletPermissionsManager view), so the
 * guardian decides and a failed fill releases the agent's coins instead of locking them.
 * The maker pair must stay at input 0 / output 0, hence randomizeOutputs: false.
 */
export async function fillOffer(
  wallet: WalletInterface,
  offer: SignedOffer,
  merchantLockingScript: string,
  description = 'Swap sats to pUSD and pay merchant'
): Promise<Fill> {
  const result = await wallet.createAction({
    description,
    inputBEEF: offer.beef,
    inputs: [{ outpoint: offer.outpoint, unlockingScript: offer.unlockingScript, inputDescription: 'maker pUSD offer' }],
    outputs: [
      { lockingScript: offer.payLockingScript, satoshis: offer.priceSats, outputDescription: 'pay market maker' },
      { lockingScript: merchantLockingScript, satoshis: 1, outputDescription: 'pUSD to merchant' }
    ],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  if (result.txid === undefined || result.tx === undefined) throw new Error('Wallet did not complete the fill')
  const atomicBeef = bytes(result.tx)
  const tx = Transaction.fromAtomicBEEF(atomicBeef)
  if (tx.outputs[0]?.lockingScript.toHex() !== offer.payLockingScript) {
    throw new Error('Wallet moved the maker payment away from output 0')
  }
  return { txid: result.txid, atomicBeef, tx }
}
