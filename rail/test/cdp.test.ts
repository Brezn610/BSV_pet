// The CDP numbers on the example from the design discussion: 100 dollars of BSV as collateral,
// 60 pUSD of debt, liquidation at 75 % loan-to-value. A price of 20 dollars per BSV keeps them exact.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_CDP_PARAMS,
  checkParams,
  collateralValueUsd,
  isLiquidatable,
  liquidationPrice,
  liquidationSplit,
  ltvBps,
  maxMintUsd,
  usdToSats,
  type Position
} from '../src/cdp/math'

const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 1e6))
const price = (dollars: number): bigint => BigInt(Math.round(dollars * 1e8))

// 5 BSV at 20 dollars = 100 dollars of collateral.
const position: Position = { collateralSats: 500_000_000n, debtUsd: usd(60) }

test('the collateral is worth 100 dollars and the position sits at 60 % loan-to-value', () => {
  assert.equal(collateralValueUsd(position.collateralSats, price(20)), usd(100))
  assert.equal(ltvBps(position, price(20)), 6_000n)
  assert.equal(usdToSats(usd(100), price(20)), 500_000_000n)
})

test('a fresh position may mint up to 66 % and no further', () => {
  const empty: Position = { collateralSats: 500_000_000n, debtUsd: 0n }
  assert.equal(maxMintUsd(empty, price(20)), usd(66))
  assert.equal(maxMintUsd(position, price(20)), usd(6))
  assert.equal(maxMintUsd({ ...position, debtUsd: usd(70) }, price(20)), 0n)
})

test('liquidation starts when the collateral falls to 80 dollars, not 75', () => {
  assert.equal(liquidationPrice(position), price(16))
  assert.equal(isLiquidatable(position, price(16.01)), false)
  assert.equal(isLiquidatable(position, price(16)), true)
  assert.equal(ltvBps(position, price(16)), 7_500n)
})

test('a liquidation at 16 dollars gives the liquidator 63 dollars of BSV and the owner the other 17', () => {
  const split = liquidationSplit(position, price(16))
  assert.equal(split.liquidatorSats, 393_750_000n)
  assert.equal(split.ownerSats, 106_250_000n)
  assert.equal(split.shortfallUsd, 0n)
  assert.equal(split.liquidatorSats + split.ownerSats, position.collateralSats)
})

test('a crash below the debt plus bonus gives the liquidator everything and reports the shortfall', () => {
  // At 12 dollars the collateral is worth 60, the liquidator is owed 63.
  const split = liquidationSplit(position, price(12))
  assert.equal(split.liquidatorSats, position.collateralSats)
  assert.equal(split.ownerSats, 0n)
  assert.equal(split.shortfallUsd, usd(3))
})

test('a healthy position cannot be liquidated, and positions without debt never can', () => {
  assert.throws(() => liquidationSplit(position, price(20)), /not liquidatable/)
  assert.equal(isLiquidatable({ collateralSats: 1n, debtUsd: 0n }, price(1)), false)
  assert.equal(liquidationPrice({ collateralSats: 500_000_000n, debtUsd: 0n }), undefined)
  assert.equal(ltvBps({ collateralSats: 0n, debtUsd: usd(1) }, price(20)), undefined)
})

test('bad prices and parameters are refused', () => {
  assert.throws(() => collateralValueUsd(1n, 0n), /price must be positive/)
  assert.doesNotThrow(() => checkParams(DEFAULT_CDP_PARAMS))
  assert.throws(() => checkParams({ ...DEFAULT_CDP_PARAMS, maxMintLtvBps: 7_500n }), /below liquidationLtvBps/)
  assert.throws(() => checkParams({ ...DEFAULT_CDP_PARAMS, liquidationLtvBps: 10_000n }), /below 100 %/)
})
