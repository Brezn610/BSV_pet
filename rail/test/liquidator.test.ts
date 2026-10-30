// The liquidator bot over a position book: quiet cycles are logged, a stale price is skipped,
// a dry run reports without touching the book, and a failed liquidation is logged and left for
// the next cycle.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiquidatorBot, jsonLineLogger, type CycleLog } from '../src/cdp/liquidator'
import { PositionBook, type SignedPrice } from '../src/cdp/positions'

const NOW = 1_793_380_000
const OWNER = '02' + 'aa'.repeat(32)
const POSITION = 'cd'.repeat(32) + '.0'
const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 1e6))
const price = (dollars: number, age = 0): SignedPrice => ({ value: BigInt(Math.round(dollars * 1e8)), signedAt: NOW - age })

const setup = (prices: SignedPrice[]) => {
  const book = new PositionBook({ now: () => NOW })
  book.open(POSITION, OWNER, 500_000_000n)
  book.mint(POSITION, OWNER, usd(60), price(20))
  const queue = [...prices]
  const lines: string[] = []
  return { book, lines, source: { latest: async () => queue.shift() ?? price(20) }, log: jsonLineLogger(line => lines.push(line)) }
}

test('a healthy position gives a logged no-action cycle', async () => {
  const { book, source, log, lines } = setup([price(20)])
  const bot = new LiquidatorBot({ book, prices: source, log })
  const entry = await bot.cycle()
  assert.equal(entry.action, 'no-action')
  assert.equal((JSON.parse(lines[0]) as CycleLog).action, 'no-action')
})

test('a stale price is skipped, not acted on', async () => {
  const { book, source, log } = setup([price(12, 300)])
  const entry = await new LiquidatorBot({ book, prices: source, log }).cycle()
  assert.equal(entry.action, 'skipped')
  assert.match(entry.error ?? '', /older than 60 s/)
  assert.equal(book.get(POSITION).status, 'open')
})

test('a dry run reports the liquidation and its split but leaves the book alone', async () => {
  const { book, source, log } = setup([price(16)])
  const bot = new LiquidatorBot({ book, prices: source, log })
  assert.equal(bot.dryRun, true)
  const entry = await bot.cycle()
  assert.equal(entry.action, 'would-liquidate')
  assert.deepEqual(entry.positions?.[0], {
    id: POSITION,
    ltvBps: '7500',
    debtUsd: '60000000',
    liquidatorSats: '393750000',
    ownerSats: '106250000'
  })
  assert.equal(book.get(POSITION).status, 'open')
})

test('a live bot liquidates through its executor; a failure is logged and retried next cycle', async () => {
  const { book, source, log } = setup([price(16), price(16)])
  let attempts = 0
  const bot = new LiquidatorBot({
    book,
    prices: source,
    log,
    execute: async (position, p) => {
      attempts += 1
      if (attempts === 1) throw new Error('watcher offline')
      book.liquidate(position.id, p)
      return 'f'.repeat(64)
    }
  })
  const failed = await bot.cycle()
  assert.equal(failed.positions?.[0].error, 'watcher offline')
  assert.equal(book.get(POSITION).status, 'open')

  const done = await bot.cycle()
  assert.equal(done.action, 'liquidated')
  assert.equal(done.positions?.[0].txid, 'f'.repeat(64))
  assert.equal(book.get(POSITION).status, 'liquidated')
})
