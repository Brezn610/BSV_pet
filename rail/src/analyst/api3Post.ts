// The newest post of a whitelisted official account, as an API3-signed response: bought from the
// TwitterAPI.io Airnode on AirnodeHub (x402, $0.01 in aUSD), checked against the signer and request
// hash in the API3 part's deployments.json, so the Analyst judges a post nobody could have edited.
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { api3Dir, loadApi3, type Api3Modules, type Api3SignedResponse } from '../cdp/api3Price'
import type { Post } from './verdict'

export interface SignedPost extends Post {
  /** Post time from the tweet id (Snowflake), unix seconds. */
  postedAt: number
  /** A retweet is someone else's words; TreasuryGuard refuses them (NotOriginalPost). */
  retweet: boolean
  response: Api3SignedResponse
}

export type PostSource = (account: string) => Promise<SignedPost>

/** The whitelisted accounts and their feeds, from the API3 owner's deployments.json. */
export function deployedTweetFeeds(dir = api3Dir()): Record<string, { airnode: string; requestHash: string }> {
  const deployment = JSON.parse(readFileSync(path.join(dir, 'deployments.json'), 'utf8')) as {
    baseSepolia: { feeds: { tweets: Record<string, { airnode: string; requestHash: string }> } }
  }
  return deployment.baseSepolia.feeds.tweets
}

export interface Api3PostSourceOptions {
  /** Pays the x402 fee in aUSD on Base Sepolia. Never logged. */
  payerPrivateKey: string
  dir?: string
  fetchFunction?: typeof fetch
  /** Serve the same signed post for this long: upstream quotas are shared, and each call costs aUSD. */
  cacheMs?: number
}

export function api3PostSource(options: Api3PostSourceOptions): PostSource {
  const dir = options.dir ?? api3Dir()
  const cacheMs = options.cacheMs ?? 60_000
  let modules: Promise<Api3Modules> | undefined
  const cache = new Map<string, { at: number; post: Promise<SignedPost> }>()

  const fetchPost = async (account: string): Promise<SignedPost> => {
    const api3 = await (modules ??= loadApi3(dir))
    const feed = deployedTweetFeeds(dir)[account]
    if (feed === undefined) throw new Error(`${account} is not a whitelisted account`)
    const tweetFeed = api3.tweetFeed(account)
    if (api3.feedRequestHash(tweetFeed).toLowerCase() !== feed.requestHash.toLowerCase()) {
      throw new Error(`the API3 code and deployments.json disagree on the request for ${account}`)
    }
    const paying = options.fetchFunction ?? api3.createPayingFetch!(options.payerPrivateKey)
    const response = await api3.fetchSignedResponse(tweetFeed.url, tweetFeed.request, paying)
    await api3.verifySignedResponse(response, feed.airnode, feed.requestHash)
    const tweet = api3.parseTweetData(response.data)
    if (typeof tweet.id !== 'string') throw new Error('signed post id is not a string')
    return { account, tweetId: tweet.id, text: tweet.text, postedAt: api3.tweetPostedAt(tweet.id), retweet: api3.isRetweet(tweet), response }
  }

  return async account => {
    const hit = cache.get(account)
    if (hit !== undefined && Date.now() - hit.at < cacheMs) return await hit.post
    const post = fetchPost(account)
    cache.set(account, { at: Date.now(), post })
    // A failed fetch must not be served from the cache.
    post.catch(() => cache.delete(account))
    return await post
  }
}
