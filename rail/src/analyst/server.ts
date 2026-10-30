// The Analyst agent as a pay-per-call service: POST /verdict answers 402 until the caller pays
// `priceSats` over BRC-121 (@bsv/402-pay), then returns a verdict on the posted tweet. The
// trading agent pays it from its own wallet, which is the track's "an AI agent makes a payment".
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import { createPaymentMiddleware } from '@bsv/402-pay/server'
import type { WalletInterface } from '@bsv/sdk'
import { analyzePost, checkPost, type AnalystVerdict, type Post } from './verdict'

export const VERDICT_PATH = '/verdict'
export const DEFAULT_PRICE_SATS = 100

export interface AnalystOptions {
  /** The analyst's own wallet: it receives the payments. */
  wallet: WalletInterface
  priceSats?: number
  /** Swap the judgement, e.g. to pin it in tests. */
  analyze?: (post: Post) => Promise<AnalystVerdict>
}

export function createAnalystApp(options: AnalystOptions): express.Express {
  const priceSats = options.priceSats ?? DEFAULT_PRICE_SATS
  const analyze = options.analyze ?? analyzePost
  const app = express()
  // calculatePrice matches paths exactly, so routing must too: otherwise "/Verdict" or
  // "/verdict/" would skip the price and still reach the route below for free.
  app.set('case sensitive routing', true)
  app.set('strict routing', true)

  app.get('/health', (_req, res) => {
    res.json({ ok: true, priceSats })
  })

  // Validate before charging, so a malformed request never costs the caller sats.
  app.use(VERDICT_PATH, express.json({ limit: '16kb' }), (req, res, next) => {
    try {
      req.body = checkPost(req.body)
      next()
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  app.use(
    createPaymentMiddleware({
      wallet: options.wallet,
      calculatePrice: path => (path === VERDICT_PATH ? priceSats : undefined)
    })
  )

  app.post(VERDICT_PATH, async (req, res) => {
    const post = req.body as Post
    const verdict = await analyze(post)
    const payment = (req as unknown as { payment?: { satoshisPaid?: number; txid?: string } }).payment
    res.json({ account: post.account, tweetId: post.tweetId, ...verdict, paidSats: payment?.satoshisPaid ?? priceSats, txid: payment?.txid })
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
