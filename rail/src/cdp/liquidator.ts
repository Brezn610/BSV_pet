// The liquidator bot, part of the agent loop. Each cycle it takes the latest signed price, asks
// the position book which positions reached the liquidation threshold, and either reports what
// it would do (dry run, until the contract's LIQUIDATE intent is deployed) or carries the
// liquidations out. Every cycle is logged as one JSON line for the dashboard, including the
// cycles where nothing happens. A failure is logged and skipped; the next cycle comes on the
// normal schedule, never in a tight retry loop.
import { liquidationSplit, ltvBps } from './math'
import type { PositionBook, PositionRecord, SignedPrice } from './positions'

export interface PriceSource {
  /** The newest signed BSV/USD price (an API3 response in production). */
  latest: () => Promise<SignedPrice>
}

/** Carries one liquidation out on BSV and returns its txid. */
export type LiquidationExecutor = (position: PositionRecord, price: SignedPrice) => Promise<string>

export type CycleAction = 'no-action' | 'would-liquidate' | 'liquidated' | 'skipped'

export interface CycleLog {
  at: string
  cycle: number
  action: CycleAction
  price?: string
  priceSignedAt?: number
  positions?: Array<{
    id: string
    ltvBps: string
    debtUsd: string
    liquidatorSats: string
    ownerSats: string
    txid?: string
    error?: string
  }>
  error?: string
}

export interface LiquidatorOptions {
  book: PositionBook
  prices: PriceSource
  /** Without an executor the bot only reports (dry run). */
  execute?: LiquidationExecutor
  log?: (entry: CycleLog) => void
  now?: () => Date
}

export class LiquidatorBot {
  private cycles = 0
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(private readonly options: LiquidatorOptions) {}

  get dryRun(): boolean {
    return this.options.execute === undefined
  }

  async cycle(): Promise<CycleLog> {
    this.cycles += 1
    const base = { at: (this.options.now?.() ?? new Date()).toISOString(), cycle: this.cycles }
    let entry: CycleLog
    try {
      const price = await this.options.prices.latest()
      const found = this.options.book.liquidatable(price)
      const priced = { ...base, price: price.value.toString(), priceSignedAt: price.signedAt }
      if (found.length === 0) {
        entry = { ...priced, action: 'no-action' }
      } else {
        const positions: NonNullable<CycleLog['positions']> = []
        for (const position of found) {
          const split = liquidationSplit(position, price.value, this.options.book.params)
          const row = {
            id: position.id,
            ltvBps: (ltvBps(position, price.value) ?? 0n).toString(),
            debtUsd: position.debtUsd.toString(),
            liquidatorSats: split.liquidatorSats.toString(),
            ownerSats: split.ownerSats.toString()
          }
          if (this.options.execute === undefined) {
            positions.push(row)
            continue
          }
          try {
            const txid = await this.options.execute(position, price)
            positions.push({ ...row, txid })
          } catch (err) {
            positions.push({ ...row, error: (err as Error).message })
          }
        }
        entry = { ...priced, action: this.dryRun ? 'would-liquidate' : 'liquidated', positions }
      }
    } catch (err) {
      entry = { ...base, action: 'skipped', error: (err as Error).message }
    }
    this.options.log?.(entry)
    return entry
  }

  /** Runs a cycle now and then every `intervalMs`; a cycle never overlaps the previous one. */
  start(intervalMs: number): void {
    if (this.timer !== undefined) return
    const tick = async (): Promise<void> => {
      if (this.running) return
      this.running = true
      try {
        await this.cycle()
      } finally {
        this.running = false
      }
    }
    void tick()
    this.timer = setInterval(() => void tick(), intervalMs)
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }
}

/** One JSON line per cycle, the format the dashboard reads. */
export const jsonLineLogger = (write: (line: string) => void = line => process.stdout.write(line + '\n')) => (entry: CycleLog): void => {
  write(JSON.stringify(entry))
}
