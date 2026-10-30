// The guardian ported from BSV_pet, on the pinned wallet-toolbox 2.14.9 (risk R4).
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { P2PKH, PrivateKey } from '@bsv/sdk'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import { config } from '../src/config'
import { EventBus } from '../src/events'
import { Guardian } from '../src/guardian/guardian'
import { bindOriginator, createGuardedWallet } from '../src/wallet/agentWallet'

const MERCHANT = 'weather.example.com'

let chain: MockChain
let agent: MockWallet
let guardian: Guardian
let pay: (sats: number) => Promise<unknown>

before(async () => {
  chain = await MockChain.create()
  agent = await chain.createWallet('agent', 50_000, 4)
  const guarded = createGuardedWallet(agent.wallet)
  guardian = new Guardian({
    manager: guarded,
    wallet: agent.wallet,
    events: new EventBus(),
    limits: config.guardian,
    issueAllowances: false,
    merchants: [{ domain: MERCHANT, label: 'Weather API', trust: 'trusted' }],
    useClaude: false
  })
  guardian.start()
  const merchantLock = new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()).toHex()
  const asMerchant = bindOriginator(guarded, MERCHANT)
  pay = async sats =>
    await asMerchant.createAction({
      description: 'Pay for an API call',
      outputs: [{ lockingScript: merchantLock, satoshis: sats, outputDescription: 'API fee' }],
      options: { acceptDelayedBroadcast: false }
    })
})

after(async () => {
  await chain.destroy()
})

test('an undeclared payment is denied and journaled', async () => {
  await assert.rejects(pay(1000))
  assert.equal(guardian.journal.at(-1)?.verdict.decision, 'deny')
})

test('a declared payment at the listed price is approved', async () => {
  await guardian.declareIntent({ merchant: MERCHANT, item: 'forecast', why: 'User asked for the weather', expectedSats: 1000, source: 'self' })
  try {
    await pay(1000)
  } finally {
    guardian.clearIntent(MERCHANT)
  }
  assert.equal(guardian.journal.at(-1)?.verdict.decision, 'approve')
})

test('a payment above the declared price is denied', async () => {
  await guardian.declareIntent({ merchant: MERCHANT, item: 'forecast', why: 'User asked for the weather', expectedSats: 1000, source: 'self' })
  try {
    await assert.rejects(pay(1500))
  } finally {
    guardian.clearIntent(MERCHANT)
  }
  const last = guardian.journal.at(-1)!
  assert.equal(last.verdict.decision, 'deny')
  assert.ok(last.verdict.findings.some(f => f.rule === 'price-match'))
})
