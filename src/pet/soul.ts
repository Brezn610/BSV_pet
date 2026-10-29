// The pet's "soul" is a single PushDrop token: a 1-sat UTXO whose script carries
// the pet's identity and a commitment to its memory and the guardian's journal.
// Every save spends the previous soul and creates the next one, so the chain of
// souls is the pet's verifiable life history. Whoever controls this UTXO owns the pet.
import { LockingScript, PushDrop, Transaction, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'

const PROTOCOL: WalletProtocol = [1, 'satspet soul']
const KEY_ID = '1'
const BASKET = 'satspet soul'
const MAGIC = 'SATSPET1'

export interface SoulSnapshot {
  name: string
  generation: number
  bornAt: string
  energy: number
  mood: string
  status: string
  /** sha256 over the pet's memories, so the memory log can be proven later without putting it on-chain. */
  memoryHash: string
  /** Head of the guardian's hash-chained decision journal. */
  guardianRoot: string
  savedAt: string
}

export interface SoulRecord {
  outpoint: string
  txid: string
  snapshot: SoulSnapshot
}

export class SoulToken {
  private readonly pushDrop: PushDrop

  constructor(private readonly wallet: WalletInterface) {
    this.pushDrop = new PushDrop(wallet)
  }

  async current(): Promise<SoulRecord | undefined> {
    const { outputs } = await this.wallet.listOutputs({ basket: BASKET, include: 'locking scripts' })
    const out = outputs.at(-1)
    if (out?.lockingScript === undefined) return undefined
    return { outpoint: out.outpoint, txid: out.outpoint.split('.')[0], snapshot: decodeSoul(out.lockingScript) }
  }

  async save(snapshot: SoulSnapshot): Promise<SoulRecord> {
    const fields = [Utils.toArray(MAGIC, 'utf8'), Utils.toArray(JSON.stringify(snapshot), 'utf8')]
    const lockingScript = await this.pushDrop.lock(fields, PROTOCOL, KEY_ID, 'self', true, true)
    const output = {
      lockingScript: lockingScript.toHex(),
      satoshis: 1,
      basket: BASKET,
      outputDescription: `Soul of ${snapshot.name} gen ${snapshot.generation}`
    }

    const previous = await this.wallet.listOutputs({ basket: BASKET, include: 'entire transactions' })
    const prev = previous.outputs.at(-1)
    if (prev === undefined) {
      const minted = await this.wallet.createAction({
        description: `Birth of ${snapshot.name}`,
        outputs: [output],
        options: { randomizeOutputs: false }
      })
      return { outpoint: `${minted.txid}.0`, txid: minted.txid!, snapshot }
    }

    const [prevTxid, prevVout] = prev.outpoint.split('.')
    const prevTx = Transaction.fromBEEF(previous.BEEF as number[], prevTxid)
    const prevScript = prevTx.outputs[Number(prevVout)].lockingScript
    const created = await this.wallet.createAction({
      description: `${snapshot.name} soul update`,
      inputBEEF: previous.BEEF,
      inputs: [{ outpoint: prev.outpoint, unlockingScriptLength: 73, inputDescription: 'Previous soul' }],
      outputs: [output],
      options: { randomizeOutputs: false }
    })
    const signable = created.signableTransaction!
    const tx = Transaction.fromAtomicBEEF(signable.tx)
    const unlocker = this.pushDrop.unlock(PROTOCOL, KEY_ID, 'self', 'all', false, 1, prevScript)
    const unlockingScript = await unlocker.sign(tx, 0)
    const signed = await this.wallet.signAction({
      reference: signable.reference,
      spends: { 0: { unlockingScript: unlockingScript.toHex() } }
    })
    return { outpoint: `${signed.txid}.0`, txid: signed.txid!, snapshot }
  }
}

export function decodeSoul(lockingScriptHex: string): SoulSnapshot {
  const { fields } = PushDrop.decode(LockingScript.fromHex(lockingScriptHex))
  if (Utils.toUTF8(fields[0]) !== MAGIC) throw new Error('Not a SatsPet soul token')
  return JSON.parse(Utils.toUTF8(fields[1])) as SoulSnapshot
}
