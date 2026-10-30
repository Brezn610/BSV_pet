// The collateral vault on the offline chain, on the design example: 5 BSV locked at 20 dollars,
// 60 pUSD of debt, liquidation at 16 dollars. The watcher co-signs only what the position book
// allows, and a liquidation repays the reserve and pays the owner in one transaction.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { Transaction } from '@bsv/sdk'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import {
  COLLATERAL_PROTOCOL,
  WATCHER_PROTOCOL,
  checkLiquidationTx,
  deriveKey,
  liquidateCollateral,
  lockCollateral,
  sighash,
  signDigest,
  withdrawCollateral,
  type KeyRef,
  type LockedCollateral,
  type WatcherApproval
} from '../src/cdp/collateral'
import { PositionBook, type SignedPrice } from '../src/cdp/positions'
import { issueReserve, receivedToken, transferToken } from '../src/cdp/reserve'
import { acceptPayment, createInvoice, invoiceTerms } from '../src/merchant/invoice'
import { LocalRegistry } from '../src/registry/localRegistry'
import type { OwnedToken } from '../src/token/split'

const COLLATERAL_SATS = 500_000_000 // 5 BSV
const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 1e6))
const priceAt = (dollars: number): SignedPrice => ({ value: BigInt(Math.round(dollars * 1e8)), signedAt: Math.floor(Date.now() / 1000) })

let chain: MockChain
let owner: MockWallet
let liquidator: MockWallet
let watcher: MockWallet
let reserve: MockWallet
let registry: LocalRegistry
let watcherKey: KeyRef
let liquidatorKey: KeyRef
let book: PositionBook

before(async () => {
  delete process.env.TOKEN_PROTOCOL
  chain = await MockChain.create()
  owner = await chain.createWallet('owner', 1_100_000_000, 4)
  liquidator = await chain.createWallet('liquidator', 20_000, 2)
  watcher = await chain.createWallet('watcher', 0, 1)
  reserve = await chain.createWallet('reserve', 20_000, 2)
  registry = new LocalRegistry()
  watcherKey = await deriveKey(watcher.wallet, WATCHER_PROTOCOL, 'vault watcher')
  liquidatorKey = await deriveKey(liquidator.wallet, COLLATERAL_PROTOCOL, 'vault liquidator')
  book = new PositionBook()
})

after(async () => {
  await chain.destroy()
})

/** The watcher: run the check first, sign only if it passes. */
const watcherThat = (check: (tx: Transaction) => void): WatcherApproval => async (tx, inputIndex) => {
  check(tx)
  return await signDigest(watcher.wallet, watcherKey, sighash(tx, inputIndex))
}

const lock = async (): Promise<LockedCollateral> => {
  const locked = await lockCollateral(owner.wallet, COLLATERAL_SATS, { liquidator: liquidatorKey.publicKey, watcher: watcherKey.publicKey })
  book.open(locked.outpoint, owner.identityKey, BigInt(COLLATERAL_SATS))
  return locked
}

test('the owner cannot withdraw while in debt, and can once the debt is repaid', async () => {
  const locked = await lock()
  book.mint(locked.outpoint, owner.identityKey, usd(60), priceAt(20))

  const closeAllowed = watcherThat(() => {
    book.close(locked.outpoint, owner.identityKey)
  })
  await assert.rejects(withdrawCollateral(owner.wallet, locked, closeAllowed), /repay the debt/)

  book.repay(locked.outpoint, usd(60))
  const before = await owner.wallet.balance()
  const withdrawn = await withdrawCollateral(owner.wallet, locked, closeAllowed)
  assert.equal(withdrawn.tx.inputs.length >= 1, true)
  const gained = (await owner.wallet.balance()) - before
  assert.ok(gained > COLLATERAL_SATS - 1_000 && gained <= COLLATERAL_SATS, `owner got ${gained} back`)
  assert.equal(book.get(locked.outpoint).status, 'closed')
})

test('a liquidation repays the reserve and pays the owner the rest, in one transaction', async () => {
  const locked = await lock()
  book.mint(locked.outpoint, owner.identityKey, usd(60), priceAt(20))

  // The reserve exists, and the liquidator holds exactly the 6,000 cents it will repay.
  const issued = await issueReserve(reserve.wallet, 1_000_000)
  await registry.submit(issued.tx)
  const toLiquidator = await createInvoice(liquidator.wallet, { assetId: issued.token.assetId, amount: 6_000, metadata: issued.token.metadata })
  const bought = await transferToken(reserve.wallet, issued.token, invoiceTerms(toLiquidator))
  await acceptPayment(liquidator.wallet, toLiquidator, bought.atomicBeef, registry)
  const pusd: OwnedToken = receivedToken(bought, toLiquidator)

  // The price falls to 16 dollars: the book says who gets what.
  const decided = book.liquidate(locked.outpoint, priceAt(16))
  const ownerSats = Number(decided.liquidation.ownerSats)
  assert.equal(ownerSats, 106_250_000)

  const repayInvoice = await createInvoice(reserve.wallet, { assetId: pusd.assetId, amount: 6_000, metadata: pusd.metadata })
  const plan = {
    locked,
    pusd,
    reservePublicKey: repayInvoice.publicKey,
    ownerIdentityKey: owner.identityKey,
    ownerSats,
    liquidatorKey
  }
  const expected = { assetId: pusd.assetId, debtUnits: 6_000, reservePublicKey: repayInvoice.publicKey, ownerSats }

  // A liquidator that shortchanges the owner gets no watcher signature, and nothing moves.
  await assert.rejects(
    liquidateCollateral(liquidator.wallet, { ...plan, ownerSats: ownerSats - 1 }, watcherThat(tx => checkLiquidationTx(tx, expected))),
    /less than their share/
  )

  const liquidatorBefore = await liquidator.wallet.balance()
  const ownerBefore = await owner.wallet.balance()
  const done = await liquidateCollateral(liquidator.wallet, plan, watcherThat(tx => checkLiquidationTx(tx, expected)))

  // The reserve takes its pUSD back through the registry.
  await acceptPayment(reserve.wallet, repayInvoice, done.atomicBeef, registry)
  assert.ok(registry.wasSpent(pusd.outpoint))

  // The owner takes in their share.
  assert.ok(done.payout !== undefined)
  await owner.wallet.internalizeAction({
    tx: done.atomicBeef,
    description: 'Liquidation refund',
    outputs: [{ outputIndex: 1, protocol: 'wallet payment', paymentRemittance: done.payout.remittance }]
  })
  assert.equal((await owner.wallet.balance()) - ownerBefore, ownerSats)

  // The liquidator keeps the rest of the collateral, less the fee and the 1-sat token output.
  const liquidatorGain = (await liquidator.wallet.balance()) - liquidatorBefore
  const due = Number(decided.liquidation.liquidatorSats)
  assert.ok(liquidatorGain > due - 1_000 && liquidatorGain <= due, `liquidator gained ${liquidatorGain}, due ${due}`)
})
