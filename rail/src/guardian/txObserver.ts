// Sits between the permissions manager and the real wallet, so the guardian can see the exact
// transaction the wallet is about to sign. The manager asks for spending authorization after
// the underlying createAction has built that transaction, but hands the guardian only totals.
import { Transaction, type CreateActionArgs, type CreateActionResult, type WalletInterface } from '@bsv/sdk'

export class TxObserver {
  /** Built but not yet authorized transactions, by the originator they were built for. */
  private readonly pending = new Map<string, Transaction[]>()

  wrap(wallet: WalletInterface): WalletInterface {
    return new Proxy(wallet, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver)
        if (prop !== 'createAction' || typeof value !== 'function') return value
        return async (args: CreateActionArgs, originator?: string): Promise<CreateActionResult> => {
          const result = (await value.call(target, args, originator)) as CreateActionResult
          if (result.signableTransaction !== undefined) {
            const key = originator ?? ''
            const list = this.pending.get(key) ?? []
            list.push(Transaction.fromAtomicBEEF(result.signableTransaction.tx))
            this.pending.set(key, list)
          }
          return result
        }
      }
    })
  }

  /** Forgets anything left over for `originator`, e.g. from a call that failed before authorization. */
  discard(originator: string): void {
    this.pending.delete(originator)
  }

  /**
   * The transaction awaiting authorization for `originator`. Taken only once. With more than
   * one in flight there is no telling which one is being authorized, so none is returned.
   */
  take(originator: string): { tx?: Transaction; inFlight: number } {
    const list = this.pending.get(originator) ?? []
    this.pending.delete(originator)
    return { tx: list.length === 1 ? list[0] : undefined, inFlight: list.length }
  }
}
