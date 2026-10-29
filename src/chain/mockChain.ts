// Offline BSV chain for demos and tests.
//
// Every wallet here is a real @bsv/wallet-toolbox Wallet: real keys, real
// signatures, real BEEF/SPV. Only the network is simulated (MockServices mines
// blocks into a local SQLite database), so the whole demo runs without wifi.
import {
  Beef,
  CachedKeyDeriver,
  PrivateKey,
  Script,
  Transaction,
  Utils,
  type CreateActionArgs,
  type SignActionArgs
} from '@bsv/sdk'
import {
  MockServices,
  Monitor,
  ScriptTemplateBRC29,
  StorageKnex,
  Wallet,
  WalletStorageManager,
  randomBytesHex
} from '@bsv/wallet-toolbox'
import type { PostBeefResult } from '@bsv/wallet-toolbox/out/src/sdk'
import knexFactory, { type Knex } from 'knex'

export interface MockWallet {
  name: string
  wallet: Wallet
  identityKey: string
  monitor: Monitor
}

/**
 * Broadcasts every transaction as soon as it is signed. The toolbox normally
 * queues broadcasts for its background Monitor; the demo does not run that
 * loop, and a queued parent would make the next payment unverifiable by the
 * merchant receiving it.
 */
class ImmediateBroadcastWallet extends Wallet {
  override async createAction(args: CreateActionArgs, originator?: string) {
    args.options = { acceptDelayedBroadcast: false, ...args.options }
    return await super.createAction(args, originator)
  }

  override async signAction(args: SignActionArgs, originator?: string) {
    args.options = { acceptDelayedBroadcast: false, ...args.options }
    return await super.signAction(args, originator)
  }
}

/**
 * MockServices with two fixes that make it behave like a real broadcaster
 * (the same two patches the BSV Association's token kit applies in its tests):
 * - re-posting a known transaction succeeds ("already known"), because both the
 *   payer and the payee of a BRC-29 payment broadcast it;
 * - when a transaction spends two outputs of the same unconfirmed parent (the
 *   soul token and its change, say), every input shares one parsed parent, so
 *   script verification can walk the whole unconfirmed ancestry.
 * Blocks are not needed for settlement: payments are final at 0-conf.
 */
class DevChainServices extends MockServices {
  constructor(knex: Knex) {
    super(knex)
    ;(this as any).hydrateInputSourcesFromBeef = (tx: Transaction, beef: Beef): void => {
      const cache = new Map<string, Transaction>()
      const walk = (t: Transaction): void => {
        for (const input of t.inputs) {
          if (input.sourceTransaction !== undefined || input.sourceTXID === undefined) continue
          let source = cache.get(input.sourceTXID)
          if (source === undefined) {
            const raw = beef.findTxid(input.sourceTXID)?.rawTx
            if (raw === undefined) continue
            source = Transaction.fromBinary(Array.from(raw))
            cache.set(input.sourceTXID, source)
            walk(source)
          }
          input.sourceTransaction = source
        }
      }
      walk(tx)
    }
  }

  override async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult[]> {
    const results: PostBeefResult[] = []
    for (const txid of txids) {
      if ((await this.storage.getTransaction(txid)) != null) {
        results.push({ name: 'MockServices', status: 'success', txidResults: [{ txid, status: 'success' }] })
      } else {
        results.push(...(await super.postBeef(beef, [txid])))
      }
    }
    return results
  }
}

function memoryKnex(): Knex {
  return knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
}

const COINBASE_MATURITY = 100

export class MockChain {
  readonly services: DevChainServices
  private readonly wallets: MockWallet[] = []
  private readonly dbs: Knex[] = []

  private constructor(private readonly chainDb: Knex) {
    this.services = new DevChainServices(chainDb)
  }

  static async create(): Promise<MockChain> {
    const chain = new MockChain(memoryKnex())
    await chain.services.initialize()
    // Coinbase outputs need 100 confirmations before they can fund wallets.
    for (let i = 0; i < COINBASE_MATURITY + 10; i++) await chain.services.mineBlock()
    return chain
  }

  async height(): Promise<number> {
    return await this.services.getHeight()
  }

  /** Mines a block and lets every wallet pick up merkle proofs for its transactions. */
  async mine(): Promise<number> {
    const header = await this.services.mineBlock()
    for (const w of this.wallets) {
      w.monitor.processNewBlockHeader(header)
      await w.monitor.runTask('CheckForProofs')
    }
    return header.height
  }

  async createWallet(name: string, fundSatoshis = 0, coins = 1, rootKeyHex = randomBytesHex(32)): Promise<MockWallet> {
    const rootKey = PrivateKey.fromHex(rootKeyHex)
    const keyDeriver = new CachedKeyDeriver(rootKey)
    const identityKey = rootKey.toPublicKey().toString()

    const db = memoryKnex()
    this.dbs.push(db)
    const provider = new StorageKnex({
      chain: 'mock',
      knex: db,
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 1 }
    })
    await provider.migrate(name, randomBytesHex(33))
    await provider.makeAvailable()

    const storage = new WalletStorageManager(identityKey, provider)
    await storage.makeAvailable()
    storage.setServices(this.services)

    const monitor = new Monitor({
      chain: 'mock',
      storage,
      services: this.services,
      chaintracks: this.services.tracker as any,
      msecsWaitPerMerkleProofServiceReq: 0,
      taskRunWaitMsecs: 5_000,
      abandonedMsecs: 300_000,
      unprovenAttemptsLimitTest: 100,
      unprovenAttemptsLimitMain: 144,
      maxRebroadcastAttempts: 0,
      startupTaskMode: 'default'
    })
    const wallet = new ImmediateBroadcastWallet({ chain: 'mock', keyDeriver, storage, services: this.services, monitor })
    // Keep several mid-sized coins instead of consolidating into one, so a payment
    // and the guardian's allowance token can be built at the same time.
    await wallet.setWalletChangeParams(8, 500)
    const mw: MockWallet = { name, wallet, identityKey, monitor }
    this.wallets.push(mw)
    if (fundSatoshis > 0) await this.fund(mw, fundSatoshis, coins)
    return mw
  }

  /**
   * Pays a mature coinbase output into the wallet, like a faucet. Splitting the
   * amount into several coins lets the wallet build two transactions at once
   * (a payment and the guardian's allowance token, for example).
   */
  async fund(target: MockWallet, satoshis: number, coins = 1): Promise<string> {
    const height = await this.height()
    const [utxo] = await this.services.storage
      .knex('mockchain_utxos')
      .where({ isCoinbase: true, spentByTxid: null })
      .where('blockHeight', '<=', height - COINBASE_MATURITY)
      .orderBy('blockHeight', 'asc')
      .limit(1)
    if (utxo == null) throw new Error('No mature coinbase left; mine more blocks')

    const sourceRow = await this.services.storage.getTransaction(utxo.txid)
    const sourceRaw = Array.from(sourceRow!.rawTx as Uint8Array | number[])
    const source = Transaction.fromBinary(sourceRaw)
    const keys = target.wallet.getClientChangeKeyPair()
    const randomB64 = (): string => Utils.toBase64(Utils.toArray(randomBytesHex(16), 'hex'))
    const derivationPrefix = randomB64()
    const suffixes = Array.from({ length: coins }, randomB64)

    const payment = new Transaction()
    payment.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff
    })
    suffixes.forEach((derivationSuffix, i) => {
      const template = new ScriptTemplateBRC29({ derivationPrefix, derivationSuffix, keyDeriver: target.wallet.keyDeriver })
      const share = Math.floor(satoshis / coins) + (i === 0 ? satoshis % coins : 0)
      payment.addOutput({ satoshis: share, lockingScript: template.lock(keys.privateKey, keys.publicKey) })
    })

    const sourceProof = await this.services.getMerklePath(utxo.txid)
    const submit = new Beef()
    submit.mergeRawTx(sourceRaw, submit.mergeBump(sourceProof.merklePath!))
    submit.mergeRawTx(payment.toUint8Array())
    const txid = payment.id('hex')
    const [posted] = await this.services.postBeef(submit, [txid])
    if (posted.status !== 'success') throw new Error(`Faucet broadcast failed: ${JSON.stringify(posted)}`)

    await this.mine()
    const proof = await this.services.getMerklePath(txid)
    const atomic = new Beef()
    atomic.mergeRawTx(payment.toUint8Array(), atomic.mergeBump(proof.merklePath!))
    await target.wallet.internalizeAction({
      tx: atomic.toBinaryAtomic(txid),
      outputs: suffixes.map((derivationSuffix, outputIndex) => ({
        outputIndex,
        protocol: 'wallet payment' as const,
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: target.identityKey }
      })),
      description: `Faucet funding for ${target.name}`
    })
    return txid
  }

  async destroy(): Promise<void> {
    for (const w of this.wallets) await w.wallet.destroy().catch(() => {})
    for (const db of this.dbs) await db.destroy().catch(() => {})
    await this.chainDb.destroy()
  }
}
