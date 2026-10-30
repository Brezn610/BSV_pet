// The Analyst agent as a pay-per-call service over BRC-121 (@bsv/402-pay). Every route answers
// 402 until the caller pays `priceSats`:
//   GET  /verdict/<account>  the newest API3-signed post of a whitelisted official account, judged
//   POST /verdict            a post the caller sends, judged
// A trading agent pays it from its own wallet, which is the track's "an AI agent makes a payment".
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import { createPaymentMiddleware } from '@bsv/402-pay/server'
import type { WalletInterface } from '@bsv/sdk'
import type { PostSource } from './api3Post'
import { analyzePost, checkPost, type AnalystVerdict, type Post } from './verdict'

export const VERDICT_PATH = '/verdict'
export const DEFAULT_PRICE_SATS = 100
const ACCOUNT_PATH = /^\/verdict\/([A-Za-z0-9_]{1,15})$/

export interface AnalystOptions {
  /** The analyst's own wallet: it receives the payments. */
  wallet: WalletInterface
  priceSats?: number
  /** Swap the judgement, e.g. to pin it in tests. */
  analyze?: (post: Post) => Promise<AnalystVerdict>
  /** Where GET /verdict/<account> gets the signed post. Without it the route does not exist. */
  postSource?: PostSource
  /** Accounts GET /verdict/<account> serves; others are refused before any payment. */
  accounts?: string[]
  /** Called after every paid answer, e.g. to log the payment. */
  onPaid?: (entry: { path: string; satoshisPaid?: number; txid?: string; verdict: AnalystVerdict; tweetId: string }) => void
}

type PaidRequest = express.Request & { payment?: { satoshisPaid?: number; txid?: string } }

export function createAnalystApp(options: AnalystOptions): express.Express {
  const priceSats = options.priceSats ?? DEFAULT_PRICE_SATS
  const analyze = options.analyze ?? analyzePost
  const app = express()
  // calculatePrice matches paths exactly, so routing must too: otherwise "/Verdict" or
  // "/verdict/" would skip the price and still reach the routes below for free.
  app.set('case sensitive routing', true)
  app.set('strict routing', true)

  app.get('/health', (_req, res) => {
    res.json({ ok: true, priceSats, accounts: options.postSource === undefined ? [] : options.accounts ?? [] })
  })

  // Validate before charging, so a malformed request never costs the caller sats.
  app.post(VERDICT_PATH, express.json({ limit: '16kb' }), (req, res, next) => {
    try {
      req.body = checkPost(req.body)
      next()
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })
  app.get(/^\/verdict\//, (req, res, next) => {
    const account = ACCOUNT_PATH.exec(req.path)?.[1]
    if (options.postSource === undefined || account === undefined || (options.accounts !== undefined && !options.accounts.includes(account))) {
      res.status(404).json({ error: 'unknown account', accounts: options.accounts ?? [] })
      return
    }
    next()
  })

  app.use(
    createPaymentMiddleware({
      wallet: options.wallet,
      calculatePrice: path => (path === VERDICT_PATH || ACCOUNT_PATH.test(path) ? priceSats : undefined)
    })
  )

  const answer = (req: PaidRequest, post: Post, verdict: AnalystVerdict) => {
    options.onPaid?.({ path: req.path, satoshisPaid: req.payment?.satoshisPaid, txid: req.payment?.txid, verdict, tweetId: post.tweetId })
    return { ...verdict, paidSats: req.payment?.satoshisPaid ?? priceSats, txid: req.payment?.txid }
  }

  app.post(VERDICT_PATH, async (req: PaidRequest, res) => {
    const post = req.body as Post
    const verdict = await analyze(post)
    res.json({ account: post.account, tweetId: post.tweetId, ...answer(req, post, verdict) })
  })

  app.get(ACCOUNT_PATH, async (req: PaidRequest, res) => {
    const account = ACCOUNT_PATH.exec(req.path)![1]
    try {
      const post = await options.postSource!(account)
      const verdict = await analyze(post)
      const { airnode, requestHash, timestamp, signature } = post.response
      res.json({
        account,
        tweetId: post.tweetId,
        text: post.text,
        postedAt: post.postedAt,
        retweet: post.retweet,
        ...answer(req, post, verdict),
        signedBy: { airnode, requestHash, timestamp, signature }
      })
    } catch (err) {
      // The caller has paid; say plainly that the upstream data failed, with the payment txid.
      res.status(502).json({ error: `could not get the signed post: ${(err as Error).message}`, txid: req.payment?.txid })
    }
  })

  return app
}

export interface RunningAnalyst {
  url: string
  server: Server
  close: () => Promise<void>
}

export async function startAnalyst(options: AnalystOptions, port = 0, host = 'localhost'): Promise<RunningAnalyst> {
  const app = createAnalystApp(options)
  const server = await new Promise<Server>(resolve => {
    const s = app.listen(port, host, () => resolve(s))
  })
  const { port: actual } = server.address() as AddressInfo
  return {
    url: `http://${host}:${actual}`,
    server,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}
