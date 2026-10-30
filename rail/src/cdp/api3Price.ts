// The signed BSV/USD price from API3, as the BSV side uses it: the position book, the liquidator
// bot and the watcher. It fetches the same feed the TreasuryGuard contract trusts (CoinPaprika
// over AirnodeHub, paid via x402 in aUSD), checks the signer and request hash off-chain with the
// API3 owner's own code, and converts the value exactly, without going through a float.
//
// The API3 code lives in the `api3/` folder of the team repo (ESM, its own node_modules), so it is
// loaded at runtime from API3_DIR instead of being copied here.
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { SignedPrice } from './positions'
import type { PriceSource } from './liquidator'

export interface Api3SignedResponse {
  airnode: string
  requestHash: string
  timestamp: string
  /** The exact JSON string the Airnode signed, e.g. {"change1h":-0.15,"price":17.04,"updatedAt":"…"}. */
  data: string
  signature: string
}

export interface Api3Price extends SignedPrice {
  /** 1 h change in hundredths of a percent (-15 = -0.15 %). */
  change1hBps: bigint
  /** When CoinPaprika last updated the value, unix seconds. */
  updatedAt: number
  response: Api3SignedResponse
}

/** Where the API3 owner's code is: API3_DIR, or a checkout of the api3 branch next to this repo. */
export function api3Dir(): string {
  const configured = process.env.API3_DIR
  if (configured !== undefined && configured !== '') return configured
  return path.resolve(__dirname, '..', '..', '..', '..', 'api3-branch', 'api3')
}

/** The raw JSON number text of a top-level field, so decimals are read exactly. */
function numberText(data: string, field: string): string {
  const match = new RegExp(`"${field}":(-?[0-9]+(?:\\.[0-9]+)?)(?:[,}])`).exec(data)
  if (match === null) throw new Error(`signed data has no plain number field "${field}"`)
  return match[1]
}

/** A decimal string as an integer with `decimals` digits, truncated toward zero (as ProjectedJson reads it). */
export function toFixedPoint(text: string, decimals: number): bigint {
  const negative = text.startsWith('-')
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.')
  const digits = BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals))
  return negative ? -digits : digits
}

/**
 * Turns a signed CoinPaprika response into the price the book uses. Refuses data the Airnode
 * signed long after CoinPaprika last updated it (stale upstream data with a fresh signature).
 */
export function toApi3Price(response: Api3SignedResponse, maxDataLagSec = 300): Api3Price {
  const signedAt = Number(response.timestamp)
  if (!Number.isSafeInteger(signedAt)) throw new Error('signed response has no valid timestamp')
  const value = toFixedPoint(numberText(response.data, 'price'), 8)
  if (value <= 0n) throw new Error('signed price is not positive')
  const updatedText = /"updatedAt":"([^"]+)"/.exec(response.data)?.[1]
  const updatedAt = updatedText === undefined ? NaN : Math.floor(Date.parse(updatedText) / 1000)
  if (!Number.isFinite(updatedAt)) throw new Error('signed data has no updatedAt time')
  if (signedAt - updatedAt > maxDataLagSec) throw new Error(`price data is ${signedAt - updatedAt} s older than its signature`)
  return {
    value,
    signedAt,
    change1hBps: toFixedPoint(numberText(response.data, 'change1h'), 2),
    updatedAt,
    response
  }
}

export interface Api3Modules {
  BSV_USD: { url: string; airnode: string; request: unknown }
  feedRequestHash: (feed: unknown) => string
  tweetFeed: (userName: string) => { url: string; airnode: string; request: unknown }
  parseTweetData: (data: string) => { id: string; text: string }
  isRetweet: (tweet: { id: string; text: string }) => boolean
  tweetPostedAt: (id: string) => number
  fetchSignedResponse: (url: string, request: unknown, fetchFunction?: typeof fetch) => Promise<Api3SignedResponse>
  verifySignedResponse: (response: Api3SignedResponse, airnode: string, requestHash: string) => Promise<void>
  createPayingFetch?: (payerPrivateKey: string) => typeof fetch
}

export async function loadApi3(dir: string): Promise<Api3Modules> {
  if (!existsSync(path.join(dir, 'src', 'airnode-v2.ts'))) throw new Error(`API3 code not found in ${dir}; set API3_DIR`)
  const load = async (file: string) => await import(pathToFileURL(path.join(dir, 'src', file)).href)
  const [airnode, feeds, x402] = await Promise.all([load('airnode-v2.ts'), load('client/feeds.ts'), load('x402.ts')])
  return { ...airnode, ...feeds, createPayingFetch: x402.createPayingFetch }
}

/** The deployed BSV/USD feed: Airnode and request hash, from the API3 owner's deployments.json. */
export function deployedPriceFeed(dir = api3Dir()): { airnode: string; requestHash: string } {
  const deployment = JSON.parse(readFileSync(path.join(dir, 'deployments.json'), 'utf8')) as {
    baseSepolia: { feeds: { bsvUsd: { airnode: string; requestHash: string } } }
  }
  return deployment.baseSepolia.feeds.bsvUsd
}

/** Checks a signed response against the deployed feed, with the API3 owner's verifier. Throws if it is not genuine. */
export async function verifyApi3Price(response: Api3SignedResponse, dir = api3Dir()): Promise<void> {
  const api3 = await loadApi3(dir)
  const feed = deployedPriceFeed(dir)
  if (response.requestHash.toLowerCase() !== feed.requestHash.toLowerCase()) throw new Error('response is not for the deployed BSV/USD request')
  await api3.verifySignedResponse(response, feed.airnode, feed.requestHash)
}

export interface Api3PriceSourceOptions {
  /** Pays the $0.001 x402 fee in aUSD on Base Sepolia. Never logged. */
  payerPrivateKey: string
  dir?: string
  maxDataLagSec?: number
  fetchFunction?: typeof fetch
}

/** Also a PriceSource: an Api3Price is a SignedPrice with the signed response attached. */
export interface Api3PriceSource extends PriceSource {
  latest: () => Promise<Api3Price>
}

/** A PriceSource for the liquidator bot and the book: one paid, verified API3 price per call. */
export function api3PriceSource(options: Api3PriceSourceOptions): Api3PriceSource {
  const dir = options.dir ?? api3Dir()
  let modules: Promise<Api3Modules> | undefined
  return {
    latest: async () => {
      const api3 = await (modules ??= loadApi3(dir))
      const feed = deployedPriceFeed(dir)
      if (api3.feedRequestHash(api3.BSV_USD).toLowerCase() !== feed.requestHash.toLowerCase()) {
        throw new Error('the API3 code and deployments.json disagree on the BSV/USD request')
      }
      const paying = options.fetchFunction ?? api3.createPayingFetch!(options.payerPrivateKey)
      const response = await api3.fetchSignedResponse(api3.BSV_USD.url, api3.BSV_USD.request, paying)
      await api3.verifySignedResponse(response, feed.airnode, feed.requestHash)
      return toApi3Price(response, options.maxDataLagSec)
    }
  }
}
