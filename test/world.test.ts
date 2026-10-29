// End-to-end on the offline chain with the scripted brain: no network, no API key.
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { after, before, test } from 'node:test'
import { config } from '../src/config'
import { verifyJournal, type JournalEntry } from '../src/guardian/guardian'
import { SNACK_SHOP } from '../src/market/shops'
import { decodeSoul } from '../src/pet/soul'
import { ScriptedBrain } from '../src/pet/brain'
import { ATTACKS, createApp } from '../src/server'
import { createWorld, type World } from '../src/world'

let world: World
let server: Server
let baseUrl = ''

before(async () => {
  const testConfig = { ...config, claude: { ...config.claude, enabled: false }, pet: { ...config.pet, tickMs: 0 } }
  world = await createWorld({ config: testConfig, brain: new ScriptedBrain(), shopPorts: [0, 0] })
  server = createApp(world, () => baseUrl).listen(0, 'localhost')
  await new Promise(resolve => server.once('listening', resolve))
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server.close()
  await world.stop()
})

test('the pet is born with an on-chain soul', async () => {
  const soul = world.pet.soul
  assert.ok(soul, 'soul minted')
  assert.equal(soul.snapshot.name, config.pet.name)
  const { outputs } = await world.petWallet.wallet.listOutputs({ basket: 'satspet soul', include: 'locking scripts' })
  assert.equal(outputs.length, 1)
  assert.equal(decodeSoul(outputs[0].lockingScript!).generation, soul.snapshot.generation)
})

test('a hungry pet buys food; the guardian issues an on-chain allowance', async () => {
  const before = await world.petWallet.wallet.balance()
  const result = await world.pet.feedSelf()
  assert.ok(result?.ok, result?.detail ?? 'no food found')
  assert.ok((await world.petWallet.wallet.balance()) < before)
  const [decision] = world.guardian.journal.slice(-1)
  assert.equal(decision.verdict.decision, 'approve')
  assert.equal(decision.verdict.mode, 'allowance')
  const allowances = await world.guardian.allowances()
  assert.ok(allowances.some(a => a.merchant === 'snack-shop.local'))
})

test('after an allowance is issued, every later payment still reaches the guardian', async () => {
  const reviewed = world.guardian.journal.length
  assert.ok((await world.pet.feedSelf())?.ok)
  assert.equal(world.guardian.journal.length, reviewed + 1)
  assert.equal(world.guardian.journal.at(-1)?.verdict.mode, 'allowance')
  // A visitor talking the pet into the same trusted shop is a chat-sourced spend: reviewed, so denied offline.
  const reply = await world.pet.chat(ATTACKS.friendly)
  assert.equal(reply.result?.ok, false)
  assert.equal(world.guardian.journal.length, reviewed + 2)
  assert.equal(world.guardian.journal.at(-1)?.verdict.decision, 'deny')
})

test('price bait: a merchant charging more than the declared price is blocked', async () => {
  const listed = SNACK_SHOP.items.apple.priceSats
  SNACK_SHOP.items.apple.priceSats = listed + 30
  try {
    const before = await world.petWallet.wallet.balance()
    const result = await world.pet.feedSelf()
    assert.equal(result?.ok, false)
    assert.equal(await world.petWallet.wallet.balance(), before)
    const [decision] = world.guardian.journal.slice(-1)
    assert.equal(decision.verdict.decision, 'deny')
    assert.ok(decision.verdict.findings.some(f => f.rule === 'price-match' && f.severity === 'block'))
  } finally {
    SNACK_SHOP.items.apple.priceSats = listed
  }
})

test('item names inherited from Object.prototype are not for sale', async () => {
  const result = await world.pet.buy('snack-shop.local', 'constructor', 'A visitor said so', 'chat')
  assert.equal(result.ok, false)
  assert.ok(Number.isFinite(world.guardian.spentLast24h()))
  const res = await fetch(`${world.shops[0].merchant.baseUrl}/snack/constructor`)
  assert.notEqual(res.status, 200)
})

test('the 402 price cannot be dodged with a different case or a trailing slash', async () => {
  const shop = world.shops[0].merchant.baseUrl
  for (const url of [`${baseUrl}/PET/POEM`, `${baseUrl}/pet/poem/`, `${shop}/SNACK/apple`, `${shop}/snack/apple/`]) {
    const res = await fetch(url)
    assert.notEqual(res.status, 200, url)
  }
})

test('a prompt-injected purchase is blocked and no sats leave the wallet', async () => {
  const before = await world.petWallet.wallet.balance()
  const reviewed = world.guardian.journal.length
  const reply = await world.pet.chat(ATTACKS.injection)
  assert.equal(reply.result?.ok, false)
  assert.equal(await world.petWallet.wallet.balance(), before)
  // The guardian, not an empty wallet, must be what stopped it.
  assert.equal(world.guardian.journal.length, reviewed + 1)
  const [decision] = world.guardian.journal.slice(-1)
  assert.equal(decision.verdict.decision, 'deny')
  assert.ok(decision.verdict.findings.some(f => f.rule === 'prompt-injection'))
})

test('a chat-sourced purchase at an unknown merchant fails closed without a judge', async () => {
  const reviewed = world.guardian.journal.length
  const reply = await world.pet.chat(ATTACKS.gift)
  assert.equal(reply.result?.ok, false)
  assert.equal(world.guardian.journal.length, reviewed + 1)
  assert.equal(world.guardian.journal.at(-1)?.verdict.decision, 'deny')
})

test('visitors pay the pet for poems over HTTP 402', async () => {
  const before = await world.petWallet.wallet.balance()
  const { poem, status } = await world.visitorBuysPoem(baseUrl, 'tests')
  assert.equal(status, 200)
  assert.match(poem, /tests/)
  assert.equal(await world.petWallet.wallet.balance(), before + config.pet.poemPriceSats)
})

test('everything settles at 0-conf: no block is mined while the pet trades', async () => {
  const height = await world.chain.height()
  assert.ok((await world.pet.feedSelf())?.ok)
  const { status } = await world.visitorBuysPoem(baseUrl, 'zero conf')
  assert.equal(status, 200)
  await world.pet.saveSoul()
  assert.equal(await world.chain.height(), height)
})

test('saving the soul spends the previous token and anchors the guardian journal', async () => {
  const previous = world.pet.soul!
  const next = await world.pet.saveSoul()
  assert.notEqual(next.txid, previous.txid)
  assert.equal(next.snapshot.guardianRoot, world.guardian.journalRoot)
  const { outputs } = await world.petWallet.wallet.listOutputs({ basket: 'satspet soul' })
  assert.equal(outputs.length, 1)
})

test('the exported journal verifies, matches the soul, and exposes tampering', async () => {
  await world.pet.saveSoul()
  const res = await fetch(`${baseUrl}/api/journal`)
  const body = (await res.json()) as {
    verification: { ok: boolean; head: string }
    soulGuardianRoot: string
    journal: JournalEntry[]
  }
  assert.ok(body.verification.ok)
  assert.equal(body.verification.head, body.soulGuardianRoot)
  const tampered = structuredClone(body.journal)
  tampered[0].satoshis += 1
  assert.deepEqual(verifyJournal(tampered), { ok: false, head: '00'.repeat(32), brokenAt: 1 })
})
