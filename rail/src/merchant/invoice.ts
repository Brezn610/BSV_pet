// Merchant side of a pUSD payment: hand out a per-order receive key, then accept the
// fill transaction once the registry admits the token output. No BTMS messaging is needed;
// the token is inserted so the stock BTMS library can still see and spend it.
import { Transaction, type ChainTracker, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import type { Admission } from '../registry/localRegistry'
import {
  btmsCustomInstructions,
  btmsTags,
  decodeToken,
  keyIdOf,
  randomDerivation,
  tokenBasket,
  tokenLabel,
  tokenProtocol,
  transferToPublicKey
} from '../token/pusd'

export interface Invoice {
  orderId: string
  assetId: string
  amount: number
  metadata?: string
  /** Per-order key derived by the merchant's wallet; the agent locks the pUSD to it. */
  publicKey: string
  expiresAt: number
  derivation: { prefix: string; suffix: string }
}

/** The part of an invoice the merchant sends to the agent in its 402 response. */
export type InvoiceTerms = Omit<Invoice, 'derivation'>

export async function createInvoice(
  wallet: WalletInterface,
  terms: { assetId: string; amount: number; metadata?: string; ttlMs?: number },
  options: { protocol?: WalletProtocol; originator?: string } = {}
): Promise<Invoice> {
  const prefix = randomDerivation()
  const suffix = randomDerivation()
  const { publicKey } = await wallet.getPublicKey(
    { protocolID: options.protocol ?? tokenProtocol(), keyID: keyIdOf(prefix, suffix), counterparty: 'self' },
    options.originator
  )
  return {
    orderId: suffix,
    assetId: terms.assetId,
    amount: terms.amount,
    metadata: terms.metadata,
    publicKey,
    expiresAt: Date.now() + (terms.ttlMs ?? 5 * 60_000),
    derivation: { prefix, suffix }
  }
}

export function invoiceTerms(invoice: Invoice): InvoiceTerms {
  const { derivation: _derivation, ...terms } = invoice
  return terms
}

/** The token output the agent must create to pay an invoice. */
export async function paymentLockingScript(terms: InvoiceTerms, protocol?: WalletProtocol): Promise<string> {
  return (await transferToPublicKey(terms.publicKey, terms.assetId, terms.amount, terms.metadata, protocol)).toHex()
}

/** Where the merchant registers a payment: LocalRegistry offline, PublicOverlayRegistry on mainnet. */
export interface TokenRegistry {
  submit: (tx: Transaction) => Promise<Admission>
}

export interface AcceptedPayment {
  txid: string
  outputIndex: number
}

/**
 * Accepts a fill for an invoice. Order matters: verify the transaction, find our output,
 * have the registry admit it, then take it into the wallet. Only then serve the request.
 */
export async function acceptPayment(
  wallet: WalletInterface,
  invoice: Invoice,
  fillAtomicBeef: number[],
  registry: TokenRegistry,
  options: { chainTracker?: ChainTracker; originator?: string; now?: number } = {}
): Promise<AcceptedPayment> {
  if ((options.now ?? Date.now()) > invoice.expiresAt) throw new Error('Invoice has expired')
  const tx = Transaction.fromAtomicBEEF(fillAtomicBeef)
  if (options.chainTracker !== undefined && !(await tx.verify(options.chainTracker))) {
    throw new Error('Payment failed SPV verification')
  }
  const outputIndex = tx.outputs.findIndex(output => {
    const token = decodeToken(output.lockingScript.toHex())
    return (
      output.satoshis === 1 &&
      token !== undefined &&
      token.lockingPublicKey === invoice.publicKey &&
      token.assetId === invoice.assetId &&
      token.amount === invoice.amount &&
      token.metadata === invoice.metadata
    )
  })
  if (outputIndex === -1) throw new Error('Payment has no pUSD output for this invoice')

  const admission = await registry.submit(tx)
  if (!admission.outputsToAdmit.includes(outputIndex)) {
    throw new Error('Registry did not admit the pUSD paid to this invoice')
  }

  await wallet.internalizeAction(
    {
      tx: fillAtomicBeef,
      description: `Receive pUSD for order ${invoice.orderId.slice(0, 8)}`,
      labels: [tokenLabel(`assetId ${invoice.assetId}`)],
      outputs: [
        {
          outputIndex,
          protocol: 'basket insertion',
          insertionRemittance: {
            basket: tokenBasket(),
            customInstructions: btmsCustomInstructions(invoice.derivation.prefix, invoice.derivation.suffix),
            tags: btmsTags('receive', invoice.assetId)
          }
        }
      ]
    },
    options.originator
  )
  return { txid: tx.id('hex'), outputIndex }
}
