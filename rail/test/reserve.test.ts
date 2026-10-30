// The pUSD reserve on the offline chain, with the official BTMS admission rules: one issuance,
// MINT as a transfer from the reserve to the owner, REPAY as a transfer back. The asset ID never
// changes, so every pUSD in circulation is the same coin.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import { circulatingUnits, issueReserve, receivedToken, transferToken } from '../src/cdp/reserve'
import { acceptPayment, createInvoice, invoiceTerms } from '../src/merchant/invoice'
import { LocalRegistry } from '../src/registry/localRegistry'
import type { OwnedToken } from '../src/token/split'

const TOTAL = 1_000_000 // 10,000 dollars of pUSD, in cents

let chain: MockChain
let reserve: MockWallet
let owner: MockWallet
let registry: LocalRegistry
let reserveToken: OwnedToken
let ownerToken: OwnedToken

before(async () => {
  delete process.env.TOKEN_PROTOCOL
  chain = await MockChain.create()
  reserve = await chain.createWallet('reserve', 20_000, 2)
  owner = await chain.createWallet('owner', 20_000, 2)
  registry = new LocalRegistry()
})

after(async () => {
  await chain.destroy()
})

test('the reserve is issued once and admitted by the registry', async () => {
  const issued = await issueReserve(reserve.wallet, TOTAL)
  assert.deepEqual((await registry.submit(issued.tx)).outputsToAdmit, [0])
  reserveToken = issued.token
  assert.equal(circulatingUnits(TOTAL, [reserveToken.amount]), 0)
})

test('MINT sends 6,000 cents from the reserve to the owner, as the same asset', async () => {
  const invoice = await createInvoice(owner.wallet, { assetId: reserveToken.assetId, amount: 6_000, metadata: reserveToken.metadata })
  const mint = await transferToken(reserve.wallet, reserveToken, invoiceTerms(invoice))
  const accepted = await acceptPayment(owner.wallet, invoice, mint.atomicBeef, registry)
  assert.equal(accepted.outputIndex, 0)

  ownerToken = receivedToken(mint, invoice)
  assert.ok(registry.isLive(ownerToken.outpoint))
  assert.ok(mint.change !== undefined && registry.isLive(mint.change.outpoint))
  assert.equal(mint.change.amount, TOTAL - 6_000)
  assert.equal(mint.change.assetId, reserveToken.assetId)
  assert.ok(registry.wasSpent(reserveToken.outpoint))

  reserveToken = mint.change
  assert.equal(circulatingUnits(TOTAL, [reserveToken.amount]), 6_000)
})

test('a transfer cannot send more than the token holds or change its metadata', async () => {
  const invoice = await createInvoice(owner.wallet, { assetId: reserveToken.assetId, amount: TOTAL, metadata: reserveToken.metadata })
  await assert.rejects(transferToken(reserve.wallet, reserveToken, invoiceTerms(invoice)), /Cannot send/)
  const forged = await createInvoice(owner.wallet, { assetId: reserveToken.assetId, amount: 1, metadata: '{"name":"fake"}' })
  await assert.rejects(transferToken(reserve.wallet, reserveToken, invoiceTerms(forged)), /metadata/)
})

test('REPAY sends the 6,000 cents back to the reserve, and nothing is left in circulation', async () => {
  const invoice = await createInvoice(reserve.wallet, { assetId: ownerToken.assetId, amount: 6_000, metadata: ownerToken.metadata })
  const repay = await transferToken(owner.wallet, ownerToken, invoiceTerms(invoice))
  assert.equal(repay.change, undefined)
  await acceptPayment(reserve.wallet, invoice, repay.atomicBeef, registry)

  const returned = receivedToken(repay, invoice)
  assert.ok(registry.isLive(returned.outpoint))
  assert.ok(registry.wasSpent(ownerToken.outpoint))
  assert.equal(circulatingUnits(TOTAL, [reserveToken.amount, returned.amount]), 0)
})
