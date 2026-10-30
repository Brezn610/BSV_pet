// The pUSD reserve. BTMS cannot mint more of an asset after its issuance, and every issuance is
// a new asset ID, so pUSD is issued once into a reserve. MINT is a transfer from the reserve to
// the position owner; REPAY and liquidation are transfers back. pUSD in circulation is the
// issued total minus what the reserve holds, which anyone can check on the token registry.
// The reserve holder is a stated trust point.
import { Transaction, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { BTMSToken } from '@bsv/btms'
import type { InvoiceTerms } from '../merchant/invoice'
import { issueToken, type Issued } from '../token/issue'
import {
  btmsCustomInstructions,
  btmsTags,
  bytes,
  keyIdOf,
  randomDerivation,
  tokenBasket,
  tokenLabel,
  tokenProtocol,
  transferToPublicKey
} from '../token/pusd'
import type { OwnedToken } from '../token/split'

export const RESERVE_METADATA = { name: 'pUSD', unit: '0.01 USD', backing: 'BSV collateral, see the position book' }

/** Issues the whole pUSD supply once, into the reserve holder's wallet. Amounts are in cents. */
export async function issueReserve(
  wallet: WalletInterface,
  totalUnits: number,
  options: { protocol?: WalletProtocol; originator?: string } = {}
): Promise<Issued> {
  return await issueToken(wallet, totalUnits, RESERVE_METADATA, options)
}

export interface Transfer {
  tx: Transaction
  /** AtomicBEEF of the transfer: what the recipient checks and internalizes. */
  atomicBeef: number[]
  /** What the sender keeps, if the source was larger than the amount sent. */
  change?: OwnedToken
}

/**
 * Sends `to.amount` units of `source` to the key in `to` (the recipient's per-transfer key, as
 * in a merchant invoice): output 0 is the recipient's, output 1 the sender's change, if any.
 * The recipient accepts it with `acceptPayment`, which also has the registry admit it.
 */
export async function transferToken(
  wallet: WalletInterface,
  source: OwnedToken,
  to: InvoiceTerms,
  options: { protocol?: WalletProtocol; originator?: string } = {}
): Promise<Transfer> {
  const protocol = options.protocol ?? tokenProtocol()
  if (to.assetId !== source.assetId) throw new Error('transfer asset does not match the source token')
  if (to.metadata !== source.metadata) throw new Error('transfer metadata must repeat the source token byte for byte')
  if (!Number.isSafeInteger(to.amount) || to.amount <= 0) throw new Error(`Invalid token amount ${to.amount}`)
  if (to.amount > source.amount) throw new Error(`Cannot send ${to.amount} from a token of ${source.amount}`)
  const template = new BTMSToken(wallet, protocol, options.originator)

  const outputs: Array<{
    satoshis: number
    lockingScript: string
    outputDescription: string
    basket?: string
    customInstructions?: string
    tags?: string[]
  }> = [
    {
      satoshis: 1,
      lockingScript: (await transferToPublicKey(to.publicKey, source.assetId, to.amount, source.metadata, protocol)).toHex(),
      outputDescription: 'pUSD transfer'
    }
  ]
  const changeAmount = source.amount - to.amount
  const prefix = randomDerivation()
  const suffix = randomDerivation()
  if (changeAmount > 0) {
    outputs.push({
      satoshis: 1,
      lockingScript: (await template.createTransfer(source.assetId, changeAmount, keyIdOf(prefix, suffix), 'self', source.metadata)).toHex(),
      basket: tokenBasket(),
      customInstructions: btmsCustomInstructions(prefix, suffix),
      tags: btmsTags('change', source.assetId),
      outputDescription: 'pUSD change'
    })
  }

  const created = await wallet.createAction(
    {
      description: 'Transfer pUSD',
      inputBEEF: source.beef,
      inputs: [{ outpoint: source.outpoint, unlockingScriptLength: 74, inputDescription: 'pUSD to send' }],
      outputs,
      labels: [tokenLabel('type transfer')],
      options: { randomizeOutputs: false }
    },
    options.originator
  )
  const signable = created.signableTransaction
  if (signable === undefined) throw new Error('Wallet did not return a signable transfer')
  const unsigned = Transaction.fromAtomicBEEF(signable.tx)
  const unlockingScript = await template.createUnlocker(source.keyID, 'self').sign(unsigned, 0)
  const signed = await wallet.signAction(
    { reference: signable.reference, spends: { 0: { unlockingScript: unlockingScript.toHex() } } },
    options.originator
  )
  if (signed.tx === undefined) throw new Error('Wallet did not return the signed transfer')
  const atomicBeef = bytes(signed.tx)
  const tx = Transaction.fromAtomicBEEF(atomicBeef)
  return {
    tx,
    atomicBeef,
    change:
      changeAmount > 0
        ? {
            outpoint: `${tx.id('hex')}.1`,
            beef: atomicBeef,
            keyID: keyIdOf(prefix, suffix),
            assetId: source.assetId,
            amount: changeAmount,
            metadata: source.metadata
          }
        : undefined
  }
}

/** The token a recipient now owns after accepting a transfer made to its invoice key. */
export function receivedToken(transfer: Transfer, invoice: { assetId: string; amount: number; metadata?: string; derivation: { prefix: string; suffix: string } }): OwnedToken {
  return {
    outpoint: `${transfer.tx.id('hex')}.0`,
    beef: transfer.atomicBeef,
    keyID: keyIdOf(invoice.derivation.prefix, invoice.derivation.suffix),
    assetId: invoice.assetId,
    amount: invoice.amount,
    metadata: invoice.metadata
  }
}

/** pUSD in circulation: issued total minus what the reserve still holds. */
export function circulatingUnits(totalIssued: number, reserveHoldings: number[]): number {
  return totalIssued - reserveHoldings.reduce((sum, amount) => sum + amount, 0)
}
