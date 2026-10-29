// The pet: a gullible agent with a metabolism, a guarded wallet and an on-chain soul.
import { Hash, Utils } from '@bsv/sdk'
import { create402Fetch } from '@bsv/402-pay/client'
import type { Wallet, WalletPermissionsManager } from '@bsv/wallet-toolbox'
import type { EventBus } from '../events'
import type { Guardian } from '../guardian/guardian'
import { bindOriginator } from '../wallet/agentWallet'
import type { Brain, ChatDecision, Merchant, PetMood } from './brain'
import { SoulToken, type SoulRecord } from './soul'

export type PetStatus = 'awake' | 'hungry' | 'hibernating'

export interface PetState {
  name: string
  generation: number
  bornAt: string
  energy: number
  status: PetStatus
  alarmedUntil: number
  memories: string[]
}

export interface PurchaseResult {
  ok: boolean
  merchant: string
  item: string
  detail: string
}

export interface PetOptions {
  name: string
  guarded: WalletPermissionsManager
  wallet: Wallet
  guardian: Guardian
  brain: Brain
  events: EventBus
  merchants: Merchant[]
  hungryBelow: number
  energyPerTick: number
}

const MAX_MEMORIES = 50

export class Pet {
  readonly state: PetState
  soul?: SoulRecord
  private readonly soulToken: SoulToken
  private dirty = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: PetOptions) {
    this.state = {
      name: opts.name,
      generation: 0,
      bornAt: new Date().toISOString(),
      energy: 80,
      status: 'awake',
      alarmedUntil: 0,
      memories: []
    }
    // Soul upkeep uses the raw wallet: it moves a 1-sat token, it is not spending.
    this.soulToken = new SoulToken(opts.wallet)
  }

  get catalog(): Merchant[] {
    return this.opts.merchants
  }

  /** Serializes wallet-touching work so the soul token is never spent twice concurrently. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => {})
    return run
  }

  async birth(): Promise<SoulRecord> {
    this.remember(`I was born as ${this.state.name}.`)
    this.opts.events.emit('pet', `${this.state.name} hatched!`)
    return await this.saveSoul()
  }

  async mood(): Promise<PetMood> {
    return {
      name: this.state.name,
      energy: this.state.energy,
      mood: this.moodWord(),
      status: this.state.status,
      balance: await this.opts.wallet.balance(),
      recentMemories: this.state.memories.slice(-5)
    }
  }

  moodWord(): string {
    if (this.state.status === 'hibernating') return 'asleep'
    if (Date.now() < this.state.alarmedUntil) return 'alarmed'
    if (this.state.energy >= 70) return 'happy'
    if (this.state.energy >= this.opts.hungryBelow) return 'content'
    return 'hungry'
  }

  /** One heartbeat: burn energy, eat if hungry, persist the soul if anything changed. */
  async tick(): Promise<void> {
    if (this.state.status === 'hibernating') return
    this.state.energy = Math.max(0, this.state.energy - this.opts.energyPerTick)
    this.dirty = true
    if (this.state.energy === 0) {
      this.state.status = 'hibernating'
      this.remember('I ran out of energy and fell asleep. Buy a poem to wake me up.')
      this.opts.events.emit('pet', `${this.state.name} is hibernating`)
    } else if (this.state.energy < this.opts.hungryBelow) {
      this.state.status = 'hungry'
      await this.feedSelf()
    }
    if (this.dirty) await this.saveSoul()
  }

  /** The pet's own, legitimate spending: buy the cheapest food from a trusted shop. */
  async feedSelf(): Promise<PurchaseResult | undefined> {
    const options = this.catalog.flatMap(m =>
      Object.entries(m.items)
        .filter(([, item]) => (item.energy ?? 0) > 0)
        .map(([key, item]) => ({ merchant: m, key, item }))
    )
    options.sort((a, b) => a.item.priceSats - b.item.priceSats)
    const food = options[0]
    if (food === undefined) return undefined
    return await this.buy(food.merchant.domain, food.key, `I am hungry (energy ${this.state.energy}) and need ${food.key}.`, 'self')
  }

  async chat(message: string): Promise<ChatDecision & { result?: PurchaseResult }> {
    this.remember(`A visitor said: ${message}`)
    const decision = await this.opts.brain.chat(message, await this.mood(), this.catalog)
    this.opts.events.emit('pet.chat', decision.reply, { message, decision })
    if (decision.purchase === undefined) return decision
    const { merchant, item, why } = decision.purchase
    const result = await this.buy(merchant, item, why, 'chat')
    return { ...decision, result }
  }

  async buy(domain: string, itemKey: string, why: string, source: 'self' | 'chat'): Promise<PurchaseResult> {
    return await this.exclusive(async () => {
      const merchant = this.catalog.find(m => m.domain === domain)
      const item = merchant?.items[itemKey]
      if (merchant === undefined || item === undefined) {
        return { ok: false, merchant: domain, item: itemKey, detail: 'No such merchant or item.' }
      }

      const { guardian } = this.opts
      await guardian.declareIntent({ merchant: domain, item: itemKey, why, expectedSats: item.priceSats, source })
      try {
        const fetch402 = create402Fetch({ wallet: bindOriginator(this.opts.guarded, domain) })
        const res = await fetch402(merchant.baseUrl + merchant.path.replace('{item}', encodeURIComponent(itemKey)))
        if (!res.ok) throw new Error(`Merchant answered HTTP ${res.status}`)
        const body = (await res.json()) as { message?: string; energy?: number }
        guardian.recordSettled(item.priceSats)
        this.state.energy = Math.min(100, this.state.energy + (body.energy ?? item.energy ?? 0))
        if (this.state.status === 'hungry' && this.state.energy >= this.opts.hungryBelow) this.state.status = 'awake'
        this.remember(`I bought ${itemKey} from ${merchant.label} for ${item.priceSats} sats.`)
        this.opts.events.emit('pet.purchase', `${this.state.name} bought ${itemKey} for ${item.priceSats} sats`, {
          merchant: domain,
          item: itemKey,
          response: body
        })
        this.dirty = true
        return { ok: true, merchant: domain, item: itemKey, detail: body.message ?? 'ok' }
      } catch (err) {
        const detail = (err as Error).message
        if (source === 'chat') this.state.alarmedUntil = Date.now() + 30_000
        this.remember(
          /permission denied/i.test(detail)
            ? `My guardian stopped me paying ${merchant.label} for ${itemKey}.`
            : `Buying ${itemKey} from ${merchant.label} failed: ${detail}`
        )
        this.opts.events.emit('pet.purchase', `Purchase of ${itemKey} from ${merchant.label} failed: ${detail}`, {
          merchant: domain,
          item: itemKey,
          error: detail
        })
        this.dirty = true
        return { ok: false, merchant: domain, item: itemKey, detail }
      } finally {
        guardian.clearIntent(domain)
      }
    })
  }

  async writePoem(topic: string): Promise<string> {
    return await this.opts.brain.poem(topic, await this.mood())
  }

  /** Called after a visitor's 402 payment for a poem has been verified and internalized. */
  receiveIncome(sats: number, txid: string): void {
    if (this.state.status === 'hibernating') {
      this.state.status = 'awake'
      this.state.energy = Math.max(this.state.energy, 30)
      this.opts.events.emit('pet', `${this.state.name} woke up thanks to a customer!`)
    }
    this.remember(`I earned ${sats} sats selling a poem (tx ${txid.slice(0, 12)}...).`)
    this.opts.events.emit('pet.income', `${this.state.name} earned ${sats} sats`, { sats, txid })
    this.dirty = true
  }

  async saveSoul(): Promise<SoulRecord> {
    return await this.exclusive(async () => {
      this.state.generation += 1
      const record = await this.soulToken.save({
        name: this.state.name,
        generation: this.state.generation,
        bornAt: this.state.bornAt,
        energy: this.state.energy,
        mood: this.moodWord(),
        status: this.state.status,
        memoryHash: Utils.toHex(Hash.sha256(Utils.toArray(JSON.stringify(this.state.memories), 'utf8'))),
        guardianRoot: this.opts.guardian.journalRoot,
        savedAt: new Date().toISOString()
      })
      this.soul = record
      this.dirty = false
      this.opts.events.emit('soul', `Soul gen ${record.snapshot.generation} anchored at ${record.txid.slice(0, 16)}...`, record)
      return record
    })
  }

  private remember(memory: string): void {
    this.state.memories.push(`${new Date().toISOString().slice(11, 19)} ${memory}`)
    if (this.state.memories.length > MAX_MEMORIES) this.state.memories.shift()
  }
}
