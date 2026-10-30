// The guardian's transaction check. Before the wallet signs, the transaction it actually built
// is compared, input by input and output by output, with the plan the agent declared. Plans
// are built by code from the offer and the invoice, never written by the model.
import { Transaction } from '@bsv/sdk'
import { LocalRegistry } from '../registry/localRegistry'
import { paymentLockingScript, type InvoiceTerms } from '../merchant/invoice'
import { checkOffer, type SignedOffer } from '../swap/offer'
import { decodeToken } from '../token/pusd'
import type { Finding } from './policy'

export interface PlannedInput {
  outpoint: string
  /** Supplied by someone else (the maker); must be used unchanged. */
  unlockingScript?: string
  /** A token input already checked on the overlay, with the BEEF that proves its history. */
  tokenBeef?: number[]
}

export interface PlannedOutput {
  lockingScript: string
  satoshis: number
  description: string
  /** A token output the BTMS rules must admit, or the token is burned. */
  token?: boolean
}

/** What the transaction must look like. Planned inputs and outputs come first, in order. */
export interface TxPlan {
  inputs: PlannedInput[]
  outputs: PlannedOutput[]
  maxFeeSats: number
}

export const DEFAULT_MAX_FEE_SATS = 500

/** The plan for filling `offer` to pay an invoice: maker's token in, maker paid at 0, pUSD to the merchant at 1. */
export async function swapPayPlan(offer: SignedOffer, invoice: InvoiceTerms, maxFeeSats = DEFAULT_MAX_FEE_SATS): Promise<TxPlan> {
  const check = checkOffer(offer)
  if (!check.ok) throw new Error(`Offer rejected: ${check.reason}`)
  if (offer.assetId !== invoice.assetId || offer.amount !== invoice.amount || offer.metadata !== invoice.metadata) {
    throw new Error(`Offer gives ${offer.amount} of ${offer.assetId}; the invoice asks for ${invoice.amount} of ${invoice.assetId}`)
  }
  return {
    inputs: [{ outpoint: offer.outpoint, unlockingScript: offer.unlockingScript, tokenBeef: offer.beef }],
    outputs: [
      { lockingScript: offer.payLockingScript, satoshis: offer.priceSats, description: 'pay market maker' },
      { lockingScript: await paymentLockingScript(invoice), satoshis: 1, description: 'pUSD to merchant', token: true }
    ],
    maxFeeSats
  }
}

function outpointOf(tx: Transaction, i: number): string {
  const input = tx.inputs[i]
  return `${input.sourceTXID ?? input.sourceTransaction?.id('hex')}.${input.sourceOutputIndex}`
}

export async function checkTransaction(tx: Transaction, plan: TxPlan): Promise<Finding[]> {
  const findings: Finding[] = []
  const block = (rule: string, detail: string): void => {
    findings.push({ rule, severity: 'block', detail })
  }

  plan.inputs.forEach((planned, i) => {
    if (i >= tx.inputs.length || outpointOf(tx, i) !== planned.outpoint) {
      block('tx-inputs', `Input ${i} should spend ${planned.outpoint}.`)
    } else if (planned.unlockingScript !== undefined && tx.inputs[i].unlockingScript?.toHex() !== planned.unlockingScript) {
      block('tx-inputs', `Input ${i} does not carry the maker's signature unchanged.`)
    }
  })
  const plannedOutpoints = new Set(plan.inputs.map(p => p.outpoint))
  for (let i = plan.inputs.length; i < tx.inputs.length; i++) {
    const outpoint = outpointOf(tx, i)
    if (plannedOutpoints.has(outpoint)) block('tx-inputs', `Input ${i} spends ${outpoint} a second time.`)
    const source = tx.inputs[i].sourceTransaction?.outputs[tx.inputs[i].sourceOutputIndex]
    if (source === undefined) {
      block('tx-inputs', `Funding input ${i} (${outpoint}) has no source transaction to check.`)
    } else if (decodeToken(source.lockingScript.toHex()) !== undefined) {
      // The wallet would burn one of the agent's own tokens as plain change money.
      block('tx-inputs', `Funding input ${i} (${outpoint}) is a token.`)
    }
  }

  plan.outputs.forEach((planned, i) => {
    const actual = tx.outputs[i]
    if (actual === undefined) {
      block('tx-outputs', `Output ${i} (${planned.description}) is missing.`)
    } else if (actual.lockingScript.toHex() !== planned.lockingScript) {
      block('tx-outputs', `Output ${i} (${planned.description}) pays a different script than planned.`)
    } else if (actual.satoshis !== planned.satoshis) {
      block('tx-outputs', `Output ${i} (${planned.description}) is ${actual.satoshis} sats, planned ${planned.satoshis}.`)
    }
  })
  for (let i = plan.outputs.length; i < tx.outputs.length; i++) {
    if (decodeToken(tx.outputs[i].lockingScript.toHex()) !== undefined) block('tx-outputs', `Unplanned output ${i} is a token.`)
  }

  try {
    const fee = tx.getFee()
    if (fee > plan.maxFeeSats) block('tx-fee', `Network fee ${fee} sats is above the ${plan.maxFeeSats} sat limit.`)
  } catch (err) {
    block('tx-fee', `Fee cannot be computed: ${(err as Error).message}`)
  }

  const tokenOutputs = plan.outputs.flatMap((p, i) => (p.token === true ? [i] : []))
  if (tokenOutputs.length > 0) {
    try {
      const registry = new LocalRegistry()
      for (const input of plan.inputs) if (input.tokenBeef !== undefined) registry.trust(input.outpoint, input.tokenBeef)
      const { outputsToAdmit } = await registry.preview(tx)
      for (const i of tokenOutputs) {
        if (!outputsToAdmit.includes(i)) block('tx-token-admission', `Token output ${i} would not be admitted by the BTMS rules: it would be burned.`)
      }
    } catch (err) {
      block('tx-token-admission', `BTMS rules could not be run: ${(err as Error).message}`)
    }
  }

  if (findings.length === 0) {
    findings.push({
      rule: 'tx-check',
      severity: 'ok',
      detail: `Transaction matches the plan: ${plan.outputs.map(o => `${o.satoshis} sats ${o.description}`).join(', ')}.`
    })
  }
  return findings
}
