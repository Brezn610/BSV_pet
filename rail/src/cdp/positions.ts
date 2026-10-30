// The book of pUSD positions: who locked which BSV collateral, how much pUSD they took from
// the reserve, and what may happen next. It applies the same rules the contract publishes,
// so the watcher, the liquidator bot and the dashboard agree on every decision. It moves no
// money: the watcher co-signs only the BSV transactions this book allows.
import {
  DEFAULT_CDP_PARAMS,
  checkParams,
  isLiquidatable,
  liquidationSplit,
  maxMintUsd,
  type CdpParams,
  type LiquidationSplit
} from './math'

/** One pUSD unit is one US cent: USD with 6 decimals per pUSD unit. */
export const USD_PER_PUSD_UNIT = 10_000n

/** A signed BSV/USD price that already passed the API3 checks: 8 decimals, signed at unix seconds. */
export interface SignedPrice {
  value: bigint
  signedAt: number
}

export type PositionStatus = 'open' | 'closed' | 'liquidated'

export interface PositionRecord {
  /** The collateral outpoint on BSV, `<txid>.<vout>`. One position per outpoint. */
  id: string
  /** The owner's identity key: the only one who may mint against or withdraw this collateral. */
  owner: string
  collateralSats: bigint
  debtUsd: bigint
  status: PositionStatus
  liquidation?: LiquidationSplit & { price: bigint }
}

export interface BookOptions {
  params?: CdpParams
  /** Oldest a signed price may be when it drives a mint or a liquidation (Chase's review: 60 s). */
  maxPriceAgeSec?: number
  now?: () => number
}

export class PositionBook {
  readonly params: CdpParams
  private readonly maxPriceAgeSec: number
  private readonly now: () => number
  private readonly positions = new Map<string, PositionRecord>()

  constructor(options: BookOptions = {}) {
    this.params = options.params ?? DEFAULT_CDP_PARAMS
    checkParams(this.params)
    this.maxPriceAgeSec = options.maxPriceAgeSec ?? 60
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  open(id: string, owner: string, collateralSats: bigint): PositionRecord {
    if (!/^[0-9a-f]{64}\.[0-9]+$/.test(id)) throw new Error('position id must be a collateral outpoint <txid>.<vout>')
    if (this.positions.has(id)) throw new Error(`collateral ${id} is already registered`)
    if (collateralSats <= 0n) throw new Error('collateral must be positive')
    const position: PositionRecord = { id, owner, collateralSats, debtUsd: 0n, status: 'open' }
    this.positions.set(id, position)
    return { ...position }
  }

  get(id: string): PositionRecord {
    const position = this.positions.get(id)
    if (position === undefined) throw new Error(`no position ${id}`)
    return { ...position }
  }

  list(): PositionRecord[] {
    return [...this.positions.values()].map(p => ({ ...p }))
  }

  /** pUSD in circulation, in USD with 6 decimals: the debt of every open position. */
  outstandingUsd(): bigint {
    return [...this.positions.values()].reduce((sum, p) => sum + p.debtUsd, 0n)
  }

  /**
   * Records a mint and returns how many pUSD units the reserve must send to the owner.
   * Whole cents only, and the position must stay at or below the mint ceiling at a fresh price.
   */
  mint(id: string, owner: string, amountUsd: bigint, price: SignedPrice): bigint {
    const position = this.openPosition(id)
    if (owner !== position.owner) throw new Error('only the owner may mint against this collateral')
    if (amountUsd <= 0n || amountUsd % USD_PER_PUSD_UNIT !== 0n) throw new Error('mint must be a positive number of whole cents')
    this.checkFresh(price)
    const room = maxMintUsd(position, price.value, this.params)
    if (amountUsd > room) throw new Error(`mint exceeds the ceiling: at most $${(Number(room) / 1e6).toFixed(2)} more at this price`)
    position.debtUsd += amountUsd
    return amountUsd / USD_PER_PUSD_UNIT
  }

  /** Records pUSD the owner returned to the reserve. Returns the debt left. */
  repay(id: string, amountUsd: bigint): bigint {
    const position = this.openPosition(id)
    if (amountUsd <= 0n || amountUsd % USD_PER_PUSD_UNIT !== 0n) throw new Error('repay must be a positive number of whole cents')
    if (amountUsd > position.debtUsd) throw new Error('repay exceeds the debt')
    position.debtUsd -= amountUsd
    return position.debtUsd
  }

  /** The owner gets the collateral back only once nothing is owed. */
  close(id: string, owner: string): PositionRecord {
    const position = this.openPosition(id)
    if (owner !== position.owner) throw new Error('only the owner may withdraw this collateral')
    if (position.debtUsd !== 0n) throw new Error('repay the debt before withdrawing the collateral')
    position.status = 'closed'
    return { ...position }
  }

  /**
   * Liquidates at a fresh signed price if the position reached the liquidation threshold.
   * Returns how the collateral splits between the liquidator and the owner.
   */
  liquidate(id: string, price: SignedPrice): PositionRecord & { liquidation: LiquidationSplit & { price: bigint } } {
    const position = this.openPosition(id)
    this.checkFresh(price)
    if (!isLiquidatable(position, price.value, this.params)) throw new Error('position is not liquidatable at this price')
    const split = liquidationSplit(position, price.value, this.params)
    position.liquidation = { ...split, price: price.value }
    position.status = 'liquidated'
    position.debtUsd = 0n
    return { ...position, liquidation: position.liquidation }
  }

  /** Open positions a liquidator could take at this price. */
  liquidatable(price: SignedPrice): PositionRecord[] {
    this.checkFresh(price)
    return [...this.positions.values()]
      .filter(p => p.status === 'open' && isLiquidatable(p, price.value, this.params))
      .map(p => ({ ...p }))
  }

  toJSON(): unknown {
    return [...this.positions.values()].map(p => ({
      ...p,
      collateralSats: p.collateralSats.toString(),
      debtUsd: p.debtUsd.toString(),
      liquidation:
        p.liquidation === undefined
          ? undefined
          : {
              liquidatorSats: p.liquidation.liquidatorSats.toString(),
              ownerSats: p.liquidation.ownerSats.toString(),
              shortfallUsd: p.liquidation.shortfallUsd.toString(),
              price: p.liquidation.price.toString()
            }
    }))
  }

  static fromJSON(data: unknown, options: BookOptions = {}): PositionBook {
    const book = new PositionBook(options)
    for (const raw of data as Array<Record<string, any>>) {
      book.positions.set(raw.id, {
        id: raw.id,
        owner: raw.owner,
        collateralSats: BigInt(raw.collateralSats),
        debtUsd: BigInt(raw.debtUsd),
        status: raw.status,
        liquidation:
          raw.liquidation === undefined
            ? undefined
            : {
                liquidatorSats: BigInt(raw.liquidation.liquidatorSats),
                ownerSats: BigInt(raw.liquidation.ownerSats),
                shortfallUsd: BigInt(raw.liquidation.shortfallUsd),
                price: BigInt(raw.liquidation.price)
              }
      })
    }
    return book
  }

  private openPosition(id: string): PositionRecord {
    const position = this.positions.get(id)
    if (position === undefined) throw new Error(`no position ${id}`)
    if (position.status !== 'open') throw new Error(`position ${id} is ${position.status}`)
    return position
  }

  private checkFresh(price: SignedPrice): void {
    const age = this.now() - price.signedAt
    if (age > this.maxPriceAgeSec) throw new Error(`price is ${age} s old, older than ${this.maxPriceAgeSec} s`)
    if (age < -60) throw new Error('price is signed in the future')
  }
}
