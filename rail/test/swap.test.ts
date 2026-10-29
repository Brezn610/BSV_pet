// End to end on the offline chain, with the pinned versions from AGENTS.md:
// issue pUSD -> split -> maker offer -> merchant invoice -> agent fill -> registry -> both sides settle.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { BTMS } from '@bsv/btms'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
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

test('the same offer cannot be filled twice', async () => {
  const other = await chain.createWallet('agent2', 20_000, 2)
  const lock = await paymentLockingScript(invoiceTerms(invoice))
  await assert.rejects(fillOffer(agentWallet(other), offer, lock))
})
