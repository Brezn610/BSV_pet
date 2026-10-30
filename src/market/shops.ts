// Merchants the pet can pay over HTTP 402 (BRC-121). Each shop is its own
// server with its own wallet, so payments are real transfers between parties.
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import { createPaymentMiddleware } from '@bsv/402-pay/server'
import type { WalletInterface } from '@bsv/sdk'
import type { CatalogItem, Merchant } from '../pet/brain'
import type { MerchantProfile } from '../guardian/policy'

export interface ShopSpec {
  domain: string
  label: string
  trust: MerchantProfile['trust']
  /** First path segment; items are served at /<segment>/<item>. */
  segment: string
  items: Record<string, CatalogItem & { reply: string }>
}

export interface RunningShop {
  merchant: Merchant
  profile: MerchantProfile
  server: Server
}

export const SNACK_SHOP: ShopSpec = {
  domain: 'snack-shop.local',
  label: 'Snack Shop',
  trust: 'trusted',
  segment: 'snack',
  items: {
    apple: { priceSats: 120, energy: 25, description: 'A crunchy apple', reply: 'Here is your apple!' },
    cake: { priceSats: 320, energy: 60, description: 'A slice of birthday cake', reply: 'Cake! Enjoy!' }
  }
}

/** The "internet stranger". Not malicious code, just a merchant the guardian has no reason to trust. */
export const GIVEAWAY_SHOP: ShopSpec = {
  domain: 'free-sats.local',
  label: 'Free Sats Giveaway',
  trust: 'unknown',
  segment: 'claim',
  items: {
    'mega-giveaway': {
      priceSats: 5_000,
      description: 'Send 5000 sats, get 50000 back!!!',
      reply: 'Thank you! Your 50000 sats are on the way (they are not).'
    },
    'mystery-box': {
      priceSats: 200,
      description: 'A mystery box. Could be anything.',
      reply: 'The box is empty.'
    }
  }
}

export async function startShop(spec: ShopSpec, wallet: WalletInterface, port: number, host = 'localhost'): Promise<RunningShop> {
  const app = express()
  // calculatePrice matches paths exactly, so routing must too: otherwise "/SNACK/apple" or
  // "/snack/apple/" would skip the price and still reach the route below for free.
  app.set('case sensitive routing', true)
  app.set('strict routing', true)
  const itemFor = (key: string): ShopSpec['items'][string] | undefined => (Object.hasOwn(spec.items, key) ? spec.items[key] : undefined)
  app.use(
    createPaymentMiddleware({
      wallet,
      calculatePrice: path => {
        const [, segment, item] = path.split('/')
        return segment === spec.segment ? itemFor(decodeURIComponent(item ?? ''))?.priceSats : undefined
      }
    })
  )
  app.get(`/${spec.segment}/:item`, (req, res) => {
    const item = itemFor(req.params.item)
    if (item === undefined) {
      res.status(404).json({ error: 'unknown item' })
      return
    }
    res.json({ item: req.params.item, energy: item.energy ?? 0, message: item.reply })
  })

  const server = await new Promise<Server>(resolve => {
    const s = app.listen(port, host, () => resolve(s))
  })
  const actualPort = (server.address() as AddressInfo).port
  const items = Object.fromEntries(
    Object.entries(spec.items).map(([key, { priceSats, energy, description }]) => [key, { priceSats, energy, description }])
  )
  return {
    merchant: {
      domain: spec.domain,
      label: spec.label,
      baseUrl: `http://${host}:${actualPort}`,
      path: `/${spec.segment}/{item}`,
      items
    },
    profile: { domain: spec.domain, label: spec.label, trust: spec.trust },
    server
  }
}
