// The collateral vault on BSV: one output per position, spendable two ways, and always with
// the watcher's co-signature.
//
//   IF <owner> CHECKSIGVERIFY ELSE <liquidator> CHECKSIGVERIFY ENDIF <watcher> CHECKSIG
//
// The script only checks signatures. It cannot see the debt on Base or what a transaction pays
// out, so the CDP rules hold because the watcher signs (SIGHASH_ALL, so over the exact outputs)
// only what the position book allows: the owner's withdrawal once the debt is repaid, or a
// liquidation that repays the debt to the reserve and pays the owner the rest. The watcher is a
// stated trust point; it can refuse, and while it refuses the collateral stays where it is.
import {
  Beef,
  Hash,
  LockingScript,
  OP,
  P2PKH,
  PublicKey,
  Random,
  Signature,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type WalletInterface,
  type WalletProtocol
} from '@bsv/sdk'
import { BTMSToken } from '@bsv/btms'
import { bytes, decodeToken, tokenProtocol, transferToPublicKey } from '../token/pusd'
import type { OwnedToken } from '../token/split'

export const COLLATERAL_PROTOCOL: WalletProtocol = [1, 'pusd collateral']
export const WATCHER_PROTOCOL: WalletProtocol = [1, 'pusd watcher']
export const BRC29_PROTOCOL: WalletProtocol = [2, '3241645161d8']

const SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
/** Two checksig signatures (up to 73 bytes each, plus push) and the branch selector. */
const UNLOCK_LENGTH = 2 * 74 + 1

export interface VaultKeys {
  owner: string
  liquidator: string
  watcher: string
}

export function collateralScript(keys: VaultKeys): LockingScript {
  const push = (hex: string) => {
    const data = Utils.toArray(hex, 'hex')
    return { op: data.length, data }
  }
  return new LockingScript([
    { op: OP.OP_IF },
    push(keys.owner),
    { op: OP.OP_CHECKSIGVERIFY },
    { op: OP.OP_ELSE },
    push(keys.liquidator),
    { op: OP.OP_CHECKSIGVERIFY },
    { op: OP.OP_ENDIF },
    push(keys.watcher),
    { op: OP.OP_CHECKSIG }
  ])
}

/** A key a wallet derived for one vault: enough to ask the same wallet for signatures later. */
export interface KeyRef {
  protocolID: WalletProtocol
  keyID: string
  publicKey: string
}

export async function deriveKey(wallet: WalletInterface, protocolID: WalletProtocol, keyID: string, originator?: string): Promise<KeyRef> {
  const { publicKey } = await wallet.getPublicKey({ protocolID, keyID, counterparty: 'self' }, originator)
  return { protocolID, keyID, publicKey }
}

export interface LockedCollateral {
  outpoint: string
  satoshis: number
  /** AtomicBEEF of the lock transaction, the input BEEF for any later spend. */
  beef: number[]
  keys: VaultKeys
  ownerKey: KeyRef
}

/** The owner locks `satoshis` of BSV as collateral, from their own wallet (BSV Desktop in production). */
export async function lockCollateral(
  owner: WalletInterface,
  satoshis: number,
  keys: { liquidator: string; watcher: string },
  options: { originator?: string } = {}
): Promise<LockedCollateral> {
  if (!Number.isSafeInteger(satoshis) || satoshis <= 0) throw new Error(`Invalid collateral ${satoshis}`)
  const ownerKey = await deriveKey(owner, COLLATERAL_PROTOCOL, Utils.toBase64(Random(16)), options.originator)
  const vaultKeys: VaultKeys = { owner: ownerKey.publicKey, ...keys }
  const created = await owner.createAction(
    {
      description: 'Lock BSV as pUSD collateral',
      outputs: [{ satoshis, lockingScript: collateralScript(vaultKeys).toHex(), outputDescription: 'pUSD collateral' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    },
    options.originator
  )
  if (created.tx === undefined || created.txid === undefined) throw new Error('Wallet did not return the lock transaction')
  return { outpoint: `${created.txid}.0`, satoshis, beef: bytes(created.tx), keys: vaultKeys, ownerKey }
}

/** The BIP-143 digest a signature over input `inputIndex` of `tx` commits to. */
export function sighash(tx: Transaction, inputIndex: number): number[] {
  const input = tx.inputs[inputIndex]
  const sourceTx = input.sourceTransaction
  if (sourceTx === undefined) throw new Error(`input ${inputIndex} has no source transaction`)
  const source = sourceTx.outputs[input.sourceOutputIndex]
  const preimage = TransactionSignature.format({
    sourceTXID: input.sourceTXID ?? sourceTx.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis!,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, i) => i !== inputIndex),
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: source.lockingScript,
    lockTime: tx.lockTime,
    scope: SCOPE
  })
  return Hash.hash256(preimage)
}

/** A checksig-format signature by `key` over `digest`, made inside the wallet that derived it. */
export async function signDigest(wallet: WalletInterface, key: Omit<KeyRef, 'publicKey'>, digest: number[], originator?: string): Promise<number[]> {
  const { signature } = await wallet.createSignature(
    { hashToDirectlySign: digest, protocolID: key.protocolID, keyID: key.keyID, counterparty: 'self' },
    originator
  )
  const sig = Signature.fromDER([...signature])
  return new TransactionSignature(sig.r, sig.s, SCOPE).toChecksigFormat()
}

export function collateralUnlock(branch: 'owner' | 'liquidator', partySig: number[], watcherSig: number[]): UnlockingScript {
  return new UnlockingScript([
    { op: watcherSig.length, data: watcherSig },
    { op: partySig.length, data: partySig },
    { op: branch === 'owner' ? OP.OP_TRUE : OP.OP_FALSE }
  ])
}

/** The watcher's half: check the transaction, then sign. Refusing throws and nothing is signed. */
export type WatcherApproval = (tx: Transaction, inputIndex: number) => Promise<number[]>

export interface Spent {
  txid: string
  tx: Transaction
  atomicBeef: number[]
}

async function finishOrAbort(
  wallet: WalletInterface,
  reference: string,
  sign: () => Promise<Record<number, { unlockingScript: string }>>,
  originator?: string
): Promise<Spent> {
  let spends: Record<number, { unlockingScript: string }>
  try {
    spends = await sign()
  } catch (err) {
    // Otherwise the wallet keeps the funding coins it reserved for this action locked.
    await wallet.abortAction({ reference }, originator)
    throw err
  }
  const signed = await wallet.signAction({ reference, spends, options: { acceptDelayedBroadcast: false } }, originator)
  if (signed.tx === undefined || signed.txid === undefined) throw new Error('Wallet did not return the signed transaction')
  const atomicBeef = bytes(signed.tx)
  return { txid: signed.txid, tx: Transaction.fromAtomicBEEF(atomicBeef), atomicBeef }
}

/** The owner takes the collateral back into their wallet; the watcher co-signs once the debt is repaid. */
export async function withdrawCollateral(
  owner: WalletInterface,
  locked: LockedCollateral,
  watcher: WatcherApproval,
  options: { originator?: string } = {}
): Promise<Spent> {
  const created = await owner.createAction(
    {
      description: 'Withdraw pUSD collateral',
      inputBEEF: locked.beef,
      inputs: [{ outpoint: locked.outpoint, unlockingScriptLength: UNLOCK_LENGTH, inputDescription: 'pUSD collateral' }],
      outputs: [],
      options: { randomizeOutputs: false }
    },
    options.originator
  )
  const signable = created.signableTransaction
  if (signable === undefined) throw new Error('Wallet did not return a signable withdrawal')
  return await finishOrAbort(
    owner,
    signable.reference,
    async () => {
      const unsigned = Transaction.fromAtomicBEEF(signable.tx)
      const ownerSig = await signDigest(owner, locked.ownerKey, sighash(unsigned, 0), options.originator)
      const watcherSig = await watcher(unsigned, 0)
      return { 0: { unlockingScript: collateralUnlock('owner', ownerSig, watcherSig).toHex() } }
    },
    options.originator
  )
}

/** Where the owner's share of a liquidation goes: a BRC-29 payment the owner can take in later. */
export interface OwnerPayout {
  lockingScript: string
  satoshis: number
  remittance: { derivationPrefix: string; derivationSuffix: string; senderIdentityKey: string }
}

export async function ownerPayout(
  liquidator: WalletInterface,
  ownerIdentityKey: string,
  satoshis: number,
  originator?: string
): Promise<OwnerPayout> {
  const derivationPrefix = Utils.toBase64(Random(16))
  const derivationSuffix = Utils.toBase64(Random(16))
  const { publicKey } = await liquidator.getPublicKey(
    { protocolID: BRC29_PROTOCOL, keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: ownerIdentityKey },
    originator
  )
  const { publicKey: senderIdentityKey } = await liquidator.getPublicKey({ identityKey: true }, originator)
  return {
    lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex(),
    satoshis,
    remittance: { derivationPrefix, derivationSuffix, senderIdentityKey }
  }
}

export interface LiquidationPlan {
  locked: LockedCollateral
  /** The liquidator's pUSD piece; its amount must equal the debt in cents. */
  pusd: OwnedToken
  /** The reserve's receive key for this repayment (an invoice key). */
  reservePublicKey: string
  /** The owner's identity key and share of the collateral, from the position book. */
  ownerIdentityKey: string
  ownerSats: number
  /** The liquidator's own key in this vault. */
  liquidatorKey: Omit<KeyRef, 'publicKey'>
}

export interface Liquidation extends Spent {
  payout?: OwnerPayout
}

/**
 * One atomic transaction: the liquidator's pUSD goes back to the reserve (output 0), the owner
 * gets their share of the collateral (output 1), and the liquidator keeps the rest as change.
 * The watcher signs over all of it, so none of it can be changed afterwards.
 */
export async function liquidateCollateral(
  liquidator: WalletInterface,
  plan: LiquidationPlan,
  watcher: WatcherApproval,
  options: { protocol?: WalletProtocol; originator?: string } = {}
): Promise<Liquidation> {
  const protocol = options.protocol ?? tokenProtocol()
  const inputBEEF = Beef.fromBinary(plan.locked.beef)
  inputBEEF.mergeBeef(plan.pusd.beef)
  const payout = plan.ownerSats > 0 ? await ownerPayout(liquidator, plan.ownerIdentityKey, plan.ownerSats, options.originator) : undefined
  const outputs = [
    {
      satoshis: 1,
      lockingScript: (await transferToPublicKey(plan.reservePublicKey, plan.pusd.assetId, plan.pusd.amount, plan.pusd.metadata, protocol)).toHex(),
      outputDescription: 'pUSD repaid to the reserve'
    },
    ...(payout === undefined ? [] : [{ satoshis: payout.satoshis, lockingScript: payout.lockingScript, outputDescription: "Owner's share of the collateral" }])
  ]
  const created = await liquidator.createAction(
    {
      description: 'Liquidate a pUSD position',
      inputBEEF: inputBEEF.toBinary(),
      inputs: [
        { outpoint: plan.locked.outpoint, unlockingScriptLength: UNLOCK_LENGTH, inputDescription: 'pUSD collateral' },
        { outpoint: plan.pusd.outpoint, unlockingScriptLength: 74, inputDescription: 'pUSD that repays the debt' }
      ],
      outputs,
      options: { randomizeOutputs: false }
    },
    options.originator
  )
  const signable = created.signableTransaction
  if (signable === undefined) throw new Error('Wallet did not return a signable liquidation')
  const spent = await finishOrAbort(
    liquidator,
    signable.reference,
    async () => {
      const unsigned = Transaction.fromAtomicBEEF(signable.tx)
      const liquidatorSig = await signDigest(liquidator, plan.liquidatorKey, sighash(unsigned, 0), options.originator)
      const watcherSig = await watcher(unsigned, 0)
      const tokenUnlock = await new BTMSToken(liquidator, protocol, options.originator).createUnlocker(plan.pusd.keyID, 'self').sign(unsigned, 1)
      return {
        0: { unlockingScript: collateralUnlock('liquidator', liquidatorSig, watcherSig).toHex() },
        1: { unlockingScript: tokenUnlock.toHex() }
      }
    },
    options.originator
  )
  return { ...spent, payout }
}

/**
 * What the watcher checks before co-signing a liquidation: output 0 returns at least the debt in
 * pUSD of the right asset to the reserve key, and output 1 pays the owner at least their share.
 */
export function checkLiquidationTx(
  tx: Transaction,
  expected: { assetId: string; debtUnits: number; reservePublicKey: string; ownerSats: number; ownerLockingScript?: string }
): void {
  const repaid = decodeToken(tx.outputs[0]?.lockingScript.toHex() ?? '')
  if (repaid === undefined || repaid.assetId !== expected.assetId) throw new Error('output 0 is not pUSD of the reserve asset')
  if (repaid.lockingPublicKey !== expected.reservePublicKey) throw new Error('output 0 does not go back to the reserve')
  if (repaid.amount < expected.debtUnits) throw new Error('output 0 repays less than the debt')
  if (expected.ownerSats > 0) {
    const share = tx.outputs[1]
    if (share === undefined || (share.satoshis ?? 0) < expected.ownerSats) throw new Error("output 1 pays the owner less than their share")
    if (expected.ownerLockingScript !== undefined && share.lockingScript.toHex() !== expected.ownerLockingScript) {
      throw new Error("output 1 does not go to the owner")
    }
  }
}
