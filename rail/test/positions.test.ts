// The position book on the design example: 5 BSV of collateral at 20 dollars, a 60 pUSD loan,
// liquidation at 75 % loan-to-value. Prices carry a signing time so freshness is checked too.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PositionBook, type SignedPrice } from '../src/cdp/positions'

const NOW = 1_793_380_000
const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 1e6))
const price = (dollars: number, age = 0): SignedPrice => ({ value: BigInt(Math.round(dollars * 1e8)), signedAt: NOW - age })

const OWNER = '02' + 'aa'.repeat(32)
const STRANGER = '03' + 'bb'.repeat(32)
const COLLATERAL = 'cd'.repeat(32) + '.0'

const freshBook = (): PositionBook => {
  const book = new PositionBook({ now: () => NOW })
  book.open(COLLATERAL, OWNER, 500_000_000n)
  return book
}

test('one position per collateral outpoint, and the id must be an outpoint', () => {
  const book = freshBook()
  assert.throws(() => book.open(COLLATERAL, OWNER, 1n), /already registered/)
  assert.throws(() => book.open('not-an-outpoint', OWNER, 1n), /outpoint/)
})

test('the owner mints 60 pUSD as 6,000 cents, and cannot pass the 66 % ceiling', () => {
  const book = freshBook()
  assert.equal(book.mint(COLLATERAL, OWNER, usd(60), price(20)), 6_000n)
  assert.equal(book.get(COLLATERAL).debtUsd, usd(60))
  assert.throws(() => book.mint(COLLATERAL, OWNER, usd(6.01), price(20)), /ceiling/)
  assert.equal(book.mint(COLLATERAL, OWNER, usd(6), price(20)), 600n)
  assert.equal(book.outstandingUsd(), usd(66))
})

test('mints need the owner, whole cents and a price at most 60 s old', () => {
  const book = freshBook()
  assert.throws(() => book.mint(COLLATERAL, STRANGER, usd(1), price(20)), /only the owner/)
  assert.throws(() => book.mint(COLLATERAL, OWNER, 1n, price(20)), /whole cents/)
  assert.throws(() => book.mint(COLLATERAL, OWNER, usd(1), price(20, 61)), /older than 60 s/)
  assert.doesNotThrow(() => book.mint(COLLATERAL, OWNER, usd(1), price(20, 60)))
})

test('collateral comes back only after the whole debt is repaid', () => {
  const book = freshBook()
  book.mint(COLLATERAL, OWNER, usd(60), price(20))
  assert.equal(book.repay(COLLATERAL, usd(20)), usd(40))
  assert.throws(() => book.close(COLLATERAL, OWNER), /repay the debt/)
  assert.throws(() => book.repay(COLLATERAL, usd(41)), /exceeds the debt/)
  book.repay(COLLATERAL, usd(40))
  assert.throws(() => book.close(COLLATERAL, STRANGER), /only the owner/)
  assert.equal(book.close(COLLATERAL, OWNER).status, 'closed')
  assert.throws(() => book.mint(COLLATERAL, OWNER, usd(1), price(20)), /is closed/)
})

test('a drop to 16 dollars makes the position liquidatable; the liquidator gets 63 dollars of BSV', () => {
  const book = freshBook()
  book.mint(COLLATERAL, OWNER, usd(60), price(20))
  assert.deepEqual(book.liquidatable(price(16.01)), [])
  assert.throws(() => book.liquidate(COLLATERAL, price(16.01)), /not liquidatable/)
  assert.equal(book.liquidatable(price(16)).length, 1)
  const done = book.liquidate(COLLATERAL, price(16))
  assert.equal(done.status, 'liquidated')
  assert.equal(done.liquidation.liquidatorSats, 393_750_000n)
  assert.equal(done.liquidation.ownerSats, 106_250_000n)
  assert.equal(book.outstandingUsd(), 0n)
  assert.throws(() => book.liquidate(COLLATERAL, price(16)), /is liquidated/)
})

test('a stale price cannot liquidate, even when it would qualify', () => {
  const book = freshBook()
  book.mint(COLLATERAL, OWNER, usd(60), price(20))
  assert.throws(() => book.liquidate(COLLATERAL, price(12, 120)), /older than 60 s/)
})

test('the book survives a save and reload', () => {
  const book = freshBook()
  book.mint(COLLATERAL, OWNER, usd(60), price(20))
  book.liquidate(COLLATERAL, price(16))
  const copy = PositionBook.fromJSON(JSON.parse(JSON.stringify(book.toJSON())), { now: () => NOW })
  assert.deepEqual(copy.list(), book.list())
})
