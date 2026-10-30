// The owner's signed MINT request: the watcher accepts the genuine one once, and refuses an
// edited amount, a stranger's signature, a replay and an expired request.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import { MintAuthorizer, signMintRequest, type MintRequest } from '../src/cdp/authorize'

const NOW = 1_793_380_000
const POSITION = 'ab'.repeat(32) + '.0'

let chain: MockChain
let owner: MockWallet
let stranger: MockWallet
let watcher: MockWallet

before(async () => {
  chain = await MockChain.create()
  owner = await chain.createWallet('owner', 0, 1)
  stranger = await chain.createWallet('stranger', 0, 1)
  watcher = await chain.createWallet('watcher', 0, 1)
})

after(async () => {
  await chain.destroy()
})

const request = (nonce: string, amountUsd = '60000000', expiresAt = NOW + 300): MintRequest => ({ position: POSITION, amountUsd, nonce, expiresAt })

test('a genuine request is accepted once, and a replay is refused', async () => {
  const authorizer = new MintAuthorizer(watcher.wallet, () => NOW)
  const signed = await signMintRequest(owner.wallet, request('n1'), watcher.identityKey)
  assert.equal(await authorizer.verify(signed, owner.identityKey), 60_000_000n)
  await assert.rejects(authorizer.verify(signed, owner.identityKey), /already used/)
})

test('an edited amount breaks the signature', async () => {
  const authorizer = new MintAuthorizer(watcher.wallet, () => NOW)
  const signed = await signMintRequest(owner.wallet, request('n2'), watcher.identityKey)
  const edited = { ...signed, request: { ...signed.request, amountUsd: '66000000' } }
  await assert.rejects(authorizer.verify(edited, owner.identityKey), /signature is invalid/)
})

test("a stranger cannot mint against the owner's collateral", async () => {
  const authorizer = new MintAuthorizer(watcher.wallet, () => NOW)
  const signed = await signMintRequest(stranger.wallet, request('n3'), watcher.identityKey)
  await assert.rejects(authorizer.verify(signed, owner.identityKey), /not from the position owner/)
  // Claiming to be the owner with the stranger's signature does not help either.
  await assert.rejects(authorizer.verify({ ...signed, owner: owner.identityKey }, owner.identityKey), /signature is invalid/)
})

test('an expired request is refused', async () => {
  const authorizer = new MintAuthorizer(watcher.wallet, () => NOW)
  const signed = await signMintRequest(owner.wallet, request('n4', '1000000', NOW - 1), watcher.identityKey)
  await assert.rejects(authorizer.verify(signed, owner.identityKey), /expired/)
})
