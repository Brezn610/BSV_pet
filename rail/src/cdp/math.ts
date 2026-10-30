// The arithmetic of a BSV-collateralised pUSD position (DAI-style CDP): how much pUSD a
// position may mint, when it can be liquidated, and how a liquidation splits the collateral.
// Pure functions on bigints, so the agent, the liquidator bot, the watcher and the dashboard
// all compute the same numbers. Units follow the API3 TreasuryGuard client: USD with 6
// decimals, price as USD per BSV with 8 decimals, collateral in sats, ratios in basis points.

export const SATS_PER_BSV = 100_000_000n
export const PRICE_SCALE = 100_000_000n
export const USD_SCALE = 1_000_000n
export const BPS = 10_000n

// sats * price / VALUE_DIVISOR = USD with 6 decimals.
const VALUE_DIVISOR = (SATS_PER_BSV * PRICE_SCALE) / USD_SCALE

export interface CdpParams {
  /** Highest loan-to-value a mint may leave the position at. */
  maxMintLtvBps: bigint
  /** Loan-to-value at or above which anyone may liquidate the position. */
  liquidationLtvBps: bigint
  /** Extra collateral the liquidator receives on top of the debt it repays. */
  liquidationBonusBps: bigint
}

// Mint up to 66 %, liquidate at 75 %: the gap keeps a fresh position from being liquidatable at once.
export const DEFAULT_CDP_PARAMS: CdpParams = {
  maxMintLtvBps: 6_600n,
  liquidationLtvBps: 7_500n,
  liquidationBonusBps: 500n
}

export interface Position {
  collateralSats: bigint
  debtUsd: bigint
}

export function checkParams (params: CdpParams): void {
  const { maxMintLtvBps, liquidationLtvBps, liquidationBonusBps } = params
  if (maxMintLtvBps <= 0n || maxMintLtvBps >= liquidationLtvBps) throw new Error('maxMintLtvBps must be above 0 and below liquidationLtvBps')
  if (liquidationLtvBps >= BPS) throw new Error('liquidationLtvBps must be below 100 %')
  if (liquidationBonusBps < 0n) throw new Error('liquidationBonusBps must not be negative')
}

function checkPrice (price: bigint): void {
  if (price <= 0n) throw new Error('price must be positive')
}

/** USD value of the collateral, rounded down. */
export function collateralValueUsd (collateralSats: bigint, price: bigint): bigint {
  checkPrice(price)
  return (collateralSats * price) / VALUE_DIVISOR
}

/** sats worth `usd` at `price`, rounded up so a payout in sats never falls short of the USD amount. */
export function usdToSats (usd: bigint, price: bigint): bigint {
  checkPrice(price)
  return (usd * VALUE_DIVISOR + price - 1n) / price
}

/** Loan-to-value in basis points, rounded up. A position with debt and no collateral is unbounded. */
export function ltvBps (position: Position, price: bigint): bigint | undefined {
  if (position.debtUsd === 0n) return 0n
  const value = collateralValueUsd(position.collateralSats, price)
  if (value === 0n) return undefined
  return (position.debtUsd * BPS + value - 1n) / value
}

/** How much more pUSD the position may mint without going above maxMintLtvBps. */
export function maxMintUsd (position: Position, price: bigint, params: CdpParams = DEFAULT_CDP_PARAMS): bigint {
  const ceiling = (collateralValueUsd(position.collateralSats, price) * params.maxMintLtvBps) / BPS
  return ceiling > position.debtUsd ? ceiling - position.debtUsd : 0n
}

export function isLiquidatable (position: Position, price: bigint, params: CdpParams = DEFAULT_CDP_PARAMS): boolean {
  if (position.debtUsd === 0n) return false
  // debt / value >= threshold, without dividing.
  return position.debtUsd * BPS >= collateralValueUsd(position.collateralSats, price) * params.liquidationLtvBps
}

/** Highest price at which the position is liquidatable, rounded down. Undefined without debt or collateral. */
export function liquidationPrice (position: Position, params: CdpParams = DEFAULT_CDP_PARAMS): bigint | undefined {
  if (position.debtUsd === 0n || position.collateralSats === 0n) return undefined
  return (position.debtUsd * BPS * VALUE_DIVISOR) / (position.collateralSats * params.liquidationLtvBps)
}

export interface LiquidationSplit {
  /** Collateral that goes to the liquidator for repaying the debt, bonus included. */
  liquidatorSats: bigint
  /** Collateral that goes back to the position's owner. */
  ownerSats: bigint
  /** Debt the collateral could not cover: the liquidator took all of it and the rest is bad debt. */
  shortfallUsd: bigint
}

/**
 * How a liquidation at `price` splits the collateral: the liquidator repays the whole debt in
 * pUSD and receives debt plus bonus in sats; the owner gets the rest back.
 */
export function liquidationSplit (position: Position, price: bigint, params: CdpParams = DEFAULT_CDP_PARAMS): LiquidationSplit {
  if (!isLiquidatable(position, price, params)) throw new Error('position is not liquidatable at this price')
  const owedUsd = (position.debtUsd * (BPS + params.liquidationBonusBps)) / BPS
  const owedSats = usdToSats(owedUsd, price)
  if (owedSats <= position.collateralSats) {
    return { liquidatorSats: owedSats, ownerSats: position.collateralSats - owedSats, shortfallUsd: 0n }
  }
  const covered = collateralValueUsd(position.collateralSats, price)
  return { liquidatorSats: position.collateralSats, ownerSats: 0n, shortfallUsd: owedUsd - covered }
}
