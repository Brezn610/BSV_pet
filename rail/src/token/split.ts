// Splits one pUSD token into exact-size pieces, so each offer sells a whole token with no
// token change (rule 1: a SINGLE|ANYONECANPAY signature does not protect change outputs).
import { Transaction, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { BTMSToken } from '@bsv/btms'
import {
  btmsCustomInstructions,
  btmsTags,
  bytes,
  keyIdOf,
  randomDerivation,
  tokenBasket,
  tokenLabel,
  tokenProtocol
} from './pusd'

export interface OwnedToken {
  outpoint: string
  /** BEEF holding the transaction that created the token, with its ancestry. */
  beef: number[]
  keyID: string
  assetId: string
  amount: number
  metadata?: string
}

export interface SplitResult {
  tx: Transaction
  /** AtomicBEEF of the split transaction, as returned by the wallet. */
  atomicBeef: number[]
  pieces: OwnedToken[]
  change?: OwnedToken
}

export async function splitToken(
  wallet: WalletInterface,
  source: OwnedToken,
  pieceAmounts: number[],
  options: { protocol?: WalletProtocol; originator?: string } = {}
): Promise<SplitResult> {
  const protocol = options.protocol ?? tokenProtocol()
  const total = pieceAmounts.reduce((sum, amount) => sum + amount, 0)
  if (total > source.amount) throw new Error(`Cannot split ${source.amount} into ${total}`)
  const template = new BTMSToken(wallet, protocol, options.originator)
  const prefix = randomDerivation()

  const plan = [...pieceAmounts, ...(total < source.amount ? [source.amount - total] : [])]
  const keys = plan.map(() => keyIdOf(prefix, randomDerivation()))
  const outputs = await Promise.all(
    plan.map(async (amount, i) => ({
      satoshis: 1,
      lockingScript: (await template.createTransfer(source.assetId, amount, keys[i], 'self', source.metadata)).toHex(),
      basket: tokenBasket(),
      customInstructions: btmsCustomInstructions(prefix, keys[i].split(' ')[1]),
      tags: btmsTags('change', source.assetId),
      outputDescription: i < pieceAmounts.length ? 'pUSD offer piece' : 'pUSD change'
    }))
  )

  const created = await wallet.createAction(
    {
      description: 'Split pUSD into offer pieces',
      inputBEEF: source.beef,
      inputs: [{ outpoint: source.outpoint, unlockingScriptLength: 74, inputDescription: 'pUSD to split' }],
      outputs,
      labels: [tokenLabel('type split')],
      options: { randomizeOutputs: false }
    },
    options.originator
  )
  const signable = created.signableTransaction
  if (signable === undefined) throw new Error('Wallet did not return a signable split transaction')
  const unsigned = Transaction.fromAtomicBEEF(signable.tx)
  const unlockingScript = await template.createUnlocker(source.keyID, 'self').sign(unsigned, 0)
  const signed = await wallet.signAction(
    { reference: signable.reference, spends: { 0: { unlockingScript: unlockingScript.toHex() } } },
    options.originator
  )
  if (signed.tx === undefined) throw new Error('Wallet did not return the signed split transaction')
  const atomicBeef = bytes(signed.tx)
  const tx = Transaction.fromAtomicBEEF(atomicBeef)
  const txid = tx.id('hex')
  const owned = plan.map((amount, vout) => ({
    outpoint: `${txid}.${vout}`,
    beef: atomicBeef,
    keyID: keys[vout],
    assetId: source.assetId,
    amount,
    metadata: source.metadata
  }))
  return {
    tx,
    atomicBeef,
    pieces: owned.slice(0, pieceAmounts.length),
    change: owned[pieceAmounts.length]
  }
}
