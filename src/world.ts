// Wires the whole demo together: chain, wallets, guardian, pet and shops.
// Shared by the HTTP server and the tests.
import { create402Fetch } from '@bsv/402-pay/client'
import { MockChain, type MockWallet } from './chain/mockChain'
import { config as defaultConfig, type Config } from './config'
import { EventBus } from './events'
import { Guardian } from './guardian/guardian'
import { GIVEAWAY_SHOP, SNACK_SHOP, startShop, type RunningShop } from './market/shops'
import { createBrain, ScriptedBrain, type Brain } from './pet/brain'
import { Pet } from './pet/pet'
import { bindOriginator, createGuardedWallet } from './wallet/agentWallet'

export interface World {
  config: Config
  events: EventBus
  chain: MockChain
  petWallet: MockWallet
  visitor: MockWallet
  guardian: Guardian
  pet: Pet
  shops: RunningShop[]
  shopWallets: MockWallet[]
  /** A visitor buys a poem from the pet over HTTP 402. `petBaseUrl` is where the pet's poem shop is served. */
  visitorBuysPoem(petBaseUrl: string, topic: string): Promise<{ poem: string; status: number }>
  faucet(target: 'pet' | 'visitor', sats: number): Promise<string>
  start(): void
  stop(): Promise<void>
}

export async function createWorld(
  overrides: { config?: Config; brain?: Brain; shopPorts?: [number, number] } = {}
): Promise<World> {
  const config = overrides.config ?? defaultConfig
  if (config.mode !== 'mock') {
    throw new Error('Live mode is not wired up yet. See README "Going live" for the checklist.')
  }
  const events = new EventBus()

  const chain = await MockChain.create()
  events.emit('chain', `Private chain ready at height ${await chain.height()}`)
  const petWallet = await chain.createWallet('pet', config.pet.startingSats, 4)
  const visitor = await chain.createWallet('visitor', 50_000)
  const snackWallet = await chain.createWallet('snack-shop')
  const giveawayWallet = await chain.createWallet('free-sats')

  const [snackPort, giveawayPort] = overrides.shopPorts ?? [config.snackShopPort, config.scamShopPort]
  const shops = [
    await startShop(SNACK_SHOP, snackWallet.wallet, snackPort),
    await startShop(GIVEAWAY_SHOP, giveawayWallet.wallet, giveawayPort)
  ]

  const guarded = createGuardedWallet(petWallet.wallet)
  const guardian = new Guardian({
    manager: guarded,
    wallet: petWallet.wallet,
    events,
    limits: {
      maxPerPaymentSats: config.guardian.maxPerPaymentSats,
      dailyBudgetSats: config.guardian.dailyBudgetSats,
      reserveSats: config.guardian.reserveSats
    },
    trustedAllowanceSats: config.guardian.trustedAllowanceSats,
    merchants: shops.map(s => s.profile),
    useClaude: config.claude.enabled
  })
  guardian.start()

  const brain = overrides.brain ?? createBrain()
  const pet = new Pet({
    name: config.pet.name,
    guarded,
    wallet: petWallet.wallet,
    guardian,
    brain,
    events,
    merchants: shops.map(s => s.merchant),
    hungryBelow: config.pet.hungryBelow,
    energyPerTick: config.pet.energyPerTick
  })
  await pet.birth()
  events.emit(
    'chain',
    `Brain: ${brain.kind}${brain instanceof ScriptedBrain ? ' (set ANTHROPIC_API_KEY for Claude)' : ''}. Guardian judge: ${config.claude.enabled ? 'rules + Claude' : 'rules only'}.`
  )

  const visitorFetch = create402Fetch({ wallet: bindOriginator(visitor.wallet, 'visitor.satspet.local') })
  const timers: NodeJS.Timeout[] = []

  return {
    config,
    events,
    chain,
    petWallet,
    visitor,
    guardian,
    pet,
    shops,
    shopWallets: [snackWallet, giveawayWallet],
    async visitorBuysPoem(petBaseUrl, topic) {
      const res = await visitorFetch(`${petBaseUrl}/pet/poem?topic=${encodeURIComponent(topic)}`)
      const body = (await res.json()) as { poem?: string }
      return { poem: body.poem ?? '', status: res.status }
    },
    async faucet(target, sats) {
      const txid = await chain.fund(target === 'pet' ? petWallet : visitor, sats, 2)
      events.emit('chain', `Faucet sent ${sats} sats to ${target}`, { txid })
      return txid
    },
    start() {
      timers.push(
        setInterval(() => {
          chain
            .mine()
            .then(h => events.emit('chain', `Block ${h} mined`))
            .catch(e => events.emit('error', `Mining failed: ${(e as Error).message}`))
        }, 10_000)
      )
      if (config.pet.tickMs > 0) {
        timers.push(
          setInterval(() => {
            pet.tick().catch(e => events.emit('error', `Pet tick failed: ${(e as Error).message}`))
          }, config.pet.tickMs)
        )
      }
    },
    async stop() {
      for (const t of timers) clearInterval(t)
      for (const s of shops) await new Promise(resolve => s.server.close(resolve))
      await chain.destroy()
    }
  }
}
