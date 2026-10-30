// A minimal tm_btms registry that runs the official BTMS admission rules in-process.
// Used offline in tests, and as the fallback if no public overlay node hosts tm_btms
// on mainnet (risk R2). It is also how the guardian previews whether a payment's
// token output would be admitted before it signs (rule: no burned tokens).
import { Beef, Transaction } from '@bsv/sdk'
import type { BTMS } from '@bsv/btms'
import BTMSTopicManager from './BTMSTopicManager'

export interface Admission {
  outputsToAdmit: number[]
  coinsToRetain: number[]
}

function outpointOf(tx: Transaction, inputIndex: number): string {
  const input = tx.inputs[inputIndex]
  return `${input.sourceTXID ?? input.sourceTransaction!.id('hex')}.${input.sourceOutputIndex}`
}

export class LocalRegistry {
  private readonly manager = new BTMSTopicManager()
  /** Admitted, unspent token outpoints and the BEEF of the transaction that created them. */
  private readonly admitted = new Map<string, number[]>()
  private readonly spent = new Set<string>()

  /** Which outputs of `tx` would be admitted, without recording anything. */
  async preview(tx: Transaction): Promise<Admission> {
    const previousCoins = tx.inputs.map((_, i) => i).filter(i => this.admitted.has(outpointOf(tx, i)))
    const result = await this.manager.identifyAdmissibleOutputs(tx.toBEEF(), previousCoins)
    return { outputsToAdmit: result.outputsToAdmit, coinsToRetain: result.coinsToRetain }
  }

  /** Submits a transaction: spends its admitted token inputs and admits its valid token outputs. */
  async submit(tx: Transaction): Promise<Admission> {
    const admission = await this.preview(tx)
    const txid = tx.id('hex')
    const beef = tx.toBEEF()
    tx.inputs.forEach((_, i) => {
      const outpoint = outpointOf(tx, i)
      if (this.admitted.delete(outpoint)) this.spent.add(outpoint)
    })
    for (const vout of admission.outputsToAdmit) this.admitted.set(`${txid}.${vout}`, beef)
    return admission
  }

  /**
   * Records a token output that was checked somewhere else (the public overlay) as admitted,
   * so preview() can run the BTMS rules on a transaction that spends it.
   */
  trust(outpoint: string, beef: number[]): void {
    this.admitted.set(outpoint, beef)
  }

  /** Admitted and not yet spent: the only state in which a token may be relied on. */
  isLive(outpoint: string): boolean {
    return this.admitted.has(outpoint)
  }

  wasSpent(outpoint: string): boolean {
    return this.spent.has(outpoint)
  }

  /** Points a BTMS library instance at this registry instead of the public overlay network. */
  attach(btms: BTMS): BTMS {
    const patched = btms as unknown as {
      broadcastWithRetry: (tx: Transaction, context: string) => Promise<void>
      lookupTokenOnOverlay: (txid: string, outputIndex: number, includeBeef?: boolean) => Promise<{ found: boolean; beef?: Beef }>
    }
    patched.broadcastWithRetry = async (tx: Transaction) => {
      const admission = await this.submit(tx)
      if (admission.outputsToAdmit.length === 0 && admission.coinsToRetain.length === 0) {
        throw new Error('Registry admitted nothing')
      }
    }
    patched.lookupTokenOnOverlay = async (txid: string, outputIndex: number, includeBeef = false) => {
      const beef = this.admitted.get(`${txid}.${outputIndex}`)
      if (beef === undefined) return { found: false }
      return { found: true, beef: includeBeef ? Beef.fromBinary(beef) : undefined }
    }
    return btms
  }
}
