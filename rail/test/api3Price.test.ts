// The API3 price on the BSV side, on a real signed CoinPaprika response from the API3 owner's
// fixtures: exact conversion, the same signer and request checks as the contract, rejection of
// an edited value, and the price driving the position book and the liquidator bot.
// Needs the api3 branch checked out (API3_DIR) with its dependencies installed; skipped otherwise.
import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { api3Dir, api3PriceSource, toApi3Price, toFixedPoint, verifyApi3Price, type Api3SignedResponse } from '../src/cdp/api3Price'
import { LiquidatorBot } from '../src/cdp/liquidator'
import { PositionBook } from '../src/cdp/positions'

const dir = api3Dir()
const fixturePath = path.join(dir, 'test', 'fixtures', 'coinpaprika-bsv-usd.json')
const ready = existsSync(fixturePath) && existsSync(path.join(dir, 'node_modules', 'viem'))
const skip = ready ? false : `API3 code not found in ${dir}; set API3_DIR`
const fixture = (): Api3SignedResponse => JSON.parse(readFileSync(fixturePath, 'utf8')) as Api3SignedResponse

test('decimal strings convert exactly, truncating like the contract', () => {
  assert.equal(toFixedPoint('17.046251500133348', 8), 1_704_625_150n)
  assert.equal(toFixedPoint('-0.15000000596046448', 2), -15n)
  assert.equal(toFixedPoint('20', 8), 2_000_000_000n)
})

test('a real signed response becomes the price the book uses', { skip }, () => {
  const price = toApi3Price(fixture())
  assert.equal(price.value, 1_704_625_150n) // $17.04625150
  assert.equal(price.change1hBps, -15n)
  assert.equal(price.signedAt, 1_793_365_414)
  assert.ok(price.signedAt >= price.updatedAt && price.signedAt - price.updatedAt < 300)
})

test('the signature is checked against the deployed BSV/USD feed', { skip }, async () => {
  await verifyApi3Price(fixture(), dir)
  const edited = { ...fixture(), data: fixture().data.replace('"price":17.', '"price":27.') }
  await assert.rejects(verifyApi3Price(edited, dir), /signed by/)
  await assert.rejects(verifyApi3Price({ ...fixture(), requestHash: '0x' + '00'.repeat(32) }, dir), /deployed BSV\/USD request/)
})

test('upstream data much older than its signature is refused', { skip }, () => {
  const old = fixture()
  old.timestamp = String(Number(old.timestamp) + 3_600)
  assert.throws(() => toApi3Price(old), /older than its signature/)
})

test('the API3 price source drives the book and the bot', { skip }, async () => {
  const response = fixture()
  // A stand-in for the paid Airnode call: same body the Airnode returns.
  const source = api3PriceSource({
    payerPrivateKey: 'unused',
    dir,
    fetchFunction: (async () => new Response(JSON.stringify(response), { status: 200 })) as typeof fetch
  })
  const price = await source.latest()
  const book = new PositionBook({ now: () => price.signedAt })
  const owner = '02' + 'aa'.repeat(32)
  const id = 'ef'.repeat(32) + '.0'
  book.open(id, owner, 500_000_000n) // 5 BSV ≈ $85.23 at $17.05
  assert.equal(book.mint(id, owner, 56_000_000n, price), 5_600n) // $56 ≤ 66 %
  const entry = await new LiquidatorBot({ book, prices: source }).cycle()
  assert.equal(entry.action, 'no-action')
  assert.equal(entry.price, '1704625150')
})
