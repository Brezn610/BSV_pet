// End to end on the offline chain, with the pinned versions from AGENTS.md:
// issue pUSD -> split -> maker offer -> merchant invoice -> agent fill -> registry -> both sides settle.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { PrivateKey } from '@bsv/sdk'
import { BTMS } from '@bsv/btms'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import { config } from '../src/config'
import { EventBus } from '../src/events'
import { Guardian } from '../src/guardian/guardian'
import { swapPayPlan } from '../src/guardian/txCheck'
import { TxObserver } from '../src/guardian/txObserver'
import { acceptPayment, createInvoice, invoiceTerms, paymentLockingScript, type Invoice } from '../src/merchant/invoice'
import { LocalRegistry } from '../src/registry/localRegistry'
import { fillOffer, previewFill, type Fill } from '../src/swap/fill'
import { checkOffer, collectProceeds, createOffer, type SignedOffer } from '../src/swap/offer'
import { BTMS_BASKET, bytes, transferToPublicKey } from '../src/token/pusd'
import { splitToken, type OwnedToken, type SplitResult } from '../src/token/split'
import { bindOriginator, createGuardedWallet } from '../src/wallet/agentWallet'

const PRICE_SATS = 5000

let chain: MockChain
let registry: LocalRegistry
let maker: MockWallet
let merchant: MockWallet
let agent: MockWallet
let split: SplitResult
let offer: SignedOffer
let invoice: Invoice
let fill: Fill
let guardianSaw: number | undefined

/** The agent's wallet as the agent sees it: behind the permissions manager, approving every spend. */
function agentWallet(owner: MockWallet) {
  const guarded = createGuardedWallet(owner.wallet)
  guarded.bindCallback('onSpendingAuthorizationRequested', async (req: any) => {
    guardianSaw = req.spending?.satoshis
    await guarded.grantPermission({ requestID: req.requestID, ephemeral: true })
  })
  return bindOriginator(guarded, 'agent.example.com')
}

before(async () => {
  chain = await MockChain.create()
  registry = new LocalRegistry()
  maker = await chain.createWallet('maker', 20_000, 2)
  merchant = await chain.createWallet('merchant', 5_000, 2)
  agent = await chain.createWallet('agent', 50_000, 4)
})

after(async () => {
  await chain.destroy()
})

test('the maker issues pUSD and splits it into exact-size pieces the registry admits', async () => {
  const btms = registry.attach(new BTMS({ wallet: maker.wallet as any, networkPreset: 'local' }))
  const issued = await btms.issue(100, { name: 'pUSD', description: '1 unit = 1 US cent (demo token)' })
  assert.ok(issued.success, issued.error ?? "issue failed")
  const { tokens } = await btms.getSpendableTokens(issued.assetId)
  assert.equal(tokens.length, 1)
  const instructions = JSON.parse(tokens[0].customInstructions!) as { derivationPrefix: string; derivationSuffix: string }
  const { BEEF } = await maker.wallet.listOutputs({ basket: BTMS_BASKET, include: 'entire transactions' })
  const source: OwnedToken = {
    outpoint: tokens[0].outpoint,
    beef: bytes(BEEF!),
    keyID: `${instructions.derivationPrefix} ${instructions.derivationSuffix}`,
    assetId: issued.assetId,
    amount: 100,
    metadata: tokens[0].token.metadata
  }

  split = await splitToken(maker.wallet, source, [1, 1, 1])
  const admission = await registry.submit(split.tx)
  assert.deepEqual(admission.outputsToAdmit, [0, 1, 2, 3])
  assert.equal(split.change?.amount, 97)
  assert.equal(await btms.getBalance(issued.assetId), 100)
})

test('a maker offer validates, and tampering with its price does not', async () => {
  offer = await createOffer(maker.wallet, split.pieces[0], PRICE_SATS)
  assert.deepEqual(checkOffer(offer), { ok: true })
  assert.equal(checkOffer({ ...offer, priceSats: PRICE_SATS - 1 }).ok, false)
  assert.equal(checkOffer(offer, offer.expiresAt + 1).ok, false)
})

test('the guardian pre-check catches a merchant output the registry would not admit', async () => {
  invoice = await createInvoice(merchant.wallet, { assetId: offer.assetId, amount: 1, metadata: offer.metadata })
  const good = await paymentLockingScript(invoiceTerms(invoice))
  assert.equal((await previewFill(offer, good, registry)).merchantOutputAdmitted, true)
  const inflated = (await transferToPublicKey(invoice.publicKey, offer.assetId, 2, offer.metadata)).toHex()
  assert.equal((await previewFill(offer, inflated, registry)).merchantOutputAdmitted, false)
})

test('the agent fills the offer in one transaction through its guarded wallet', async () => {
  const lock = await paymentLockingScript(invoiceTerms(invoice))
  fill = await fillOffer(agentWallet(agent), offer, lock)
  assert.equal(fill.tx.outputs[0].satoshis, PRICE_SATS)
  assert.equal(fill.tx.outputs[1].satoshis, 1)
  assert.equal(guardianSaw, PRICE_SATS + fill.tx.getFee())
})

test('the merchant accepts the pUSD without BTMS messaging and can see it in BTMS', async () => {
  const accepted = await acceptPayment(merchant.wallet, invoice, fill.atomicBeef, registry)
  assert.equal(accepted.txid, fill.txid)
  assert.equal(registry.isLive(offer.outpoint), false)
  const merchantBtms = registry.attach(new BTMS({ wallet: merchant.wallet as any, networkPreset: 'local' }))
  assert.equal(await merchantBtms.getBalance(offer.assetId), 1)
})

test('the maker collects exactly the offer price', async () => {
  const before = await maker.wallet.balance()
  await collectProceeds(maker.wallet, offer, fill.atomicBeef)
  assert.equal(await maker.wallet.balance(), before + PRICE_SATS)
})

/** An agent wallet behind the real guardian with the transaction check switched on. */
async function firewalledAgent(name: string) {
  const payer = await chain.createWallet(name, 20_000, 2)
  const observer = new TxObserver()
  const guarded = createGuardedWallet(payer.wallet, observer)
  const guardian = new Guardian({
    manager: guarded,
    wallet: payer.wallet,
    events: new EventBus(),
    limits: config.guardian,
    issueAllowances: false,
    merchants: [{ domain: SHOP, label: 'Shop', trust: 'trusted' }],
    useClaude: false,
    observer
  })
  guardian.start()
  return { guardian, wallet: bindOriginator(guarded, SHOP) }
}

const SHOP = 'shop.example.com'
const intentFor = (o: SignedOffer) => ({ merchant: SHOP, item: `${o.amount} pUSD`, why: 'Pay for an API call', expectedSats: o.priceSats + 1, source: 'self' as const })

test('a fill previews the same against a registry that only trusts the offer outpoint', async () => {
  const second = await createOffer(maker.wallet, split.pieces[1], PRICE_SATS)
  const terms = invoiceTerms(await createInvoice(merchant.wallet, { assetId: second.assetId, amount: 1, metadata: second.metadata }))
  // As on mainnet: the agent's registry knows only the offer, checked on the public overlay.
  const trusting = new LocalRegistry()
  trusting.trust(second.outpoint, second.beef)
  assert.equal((await previewFill(second, await paymentLockingScript(terms), trusting)).merchantOutputAdmitted, true)
})

test('the transaction check blocks a fill that pays someone other than the invoice, and the offer survives', async () => {
  const second = await createOffer(maker.wallet, split.pieces[1], PRICE_SATS)
  const terms = invoiceTerms(await createInvoice(merchant.wallet, { assetId: second.assetId, amount: 1, metadata: second.metadata }))
  const { guardian, wallet } = await firewalledAgent('agent3')

  // Same price and amount, so the totals look right; only the recipient key was swapped.
  const thief = await transferToPublicKey(PrivateKey.fromRandom().toPublicKey().toString(), second.assetId, 1, second.metadata)
  await guardian.declareIntent(intentFor(second), await swapPayPlan(second, terms))
  await assert.rejects(fillOffer(wallet, second, thief.toHex()))
  const denied = guardian.journal.at(-1)!
  assert.equal(denied.verdict.decision, 'deny')
  assert.ok(denied.verdict.findings.some(f => f.rule === 'tx-outputs' && f.severity === 'block'))

  // The denied fill was aborted, so the maker's token and the agent's coins are still free.
  await guardian.declareIntent(intentFor(second), await swapPayPlan(second, terms))
  await fillOffer(wallet, second, await paymentLockingScript(terms))
  const approved = guardian.journal.at(-1)!
  assert.equal(approved.verdict.decision, 'approve')
  assert.ok(approved.verdict.findings.some(f => f.rule === 'tx-check' && f.severity === 'ok'))
})

test('the transaction check blocks a payment without a plan', async () => {
  const third = await createOffer(maker.wallet, split.pieces[2], PRICE_SATS)
  const terms = invoiceTerms(await createInvoice(merchant.wallet, { assetId: third.assetId, amount: 1, metadata: third.metadata }))
  const { guardian, wallet } = await firewalledAgent('agent4')
  await guardian.declareIntent(intentFor(third))
  await assert.rejects(fillOffer(wallet, third, await paymentLockingScript(terms)))
  assert.ok(guardian.journal.at(-1)!.verdict.findings.some(f => f.rule === 'tx-check' && f.severity === 'block'))
})

test('a plan cannot be built for an invoice the offer does not cover', async () => {
  const third = await createOffer(maker.wallet, split.pieces[2], PRICE_SATS)
  const terms = invoiceTerms(await createInvoice(merchant.wallet, { assetId: third.assetId, amount: 2, metadata: third.metadata }))
  await assert.rejects(swapPayPlan(third, terms), /invoice asks for 2/)
})

test('the same offer cannot be filled twice', async () => {
  const other = await chain.createWallet('agent2', 20_000, 2)
  const lock = await paymentLockingScript(invoiceTerms(invoice))
  await assert.rejects(fillOffer(agentWallet(other), offer, lock))
})
