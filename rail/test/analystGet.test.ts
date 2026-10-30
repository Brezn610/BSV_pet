// GET /verdict/<account>: the Analyst fetches the newest signed post itself, so a paying agent
// needs nothing but the URL. Unknown accounts are refused before any payment. The signed-post
// source is checked on a real signed TwitterAPI.io response from the API3 owner's fixtures.
import assert from 'node:assert/strict'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { create402Fetch } from '@bsv/402-pay/client'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import { api3PostSource, type SignedPost } from '../src/analyst/api3Post'
import { startAnalyst, type RunningAnalyst } from '../src/analyst/server'
import { api3Dir } from '../src/cdp/api3Price'
import { bindOriginator } from '../src/wallet/agentWallet'

const PRICE_SATS = 100
const POST: SignedPost = {
  account: 'WhiteHouse',
  tweetId: '1985000000000000001',
  text: 'New tariffs and a crackdown on crypto exchanges announced today.',
  postedAt: 1_793_360_000,
  retweet: false,
  response: { airnode: '0xairnode', requestHash: '0xhash', timestamp: '1793360060', data: '{}', signature: '0xsig' }
}

let chain: MockChain
let analystWallet: MockWallet
let agent: MockWallet
let analyst: RunningAnalyst
let fetched = 0

before(async () => {
  chain = await MockChain.create()
  analystWallet = await chain.createWallet('analyst', 1_000, 1)
  agent = await chain.createWallet('agent', 20_000, 4)
  analyst = await startAnalyst({
    wallet: analystWallet.wallet,
    priceSats: PRICE_SATS,
    accounts: ['WhiteHouse'],
    postSource: async account => {
      fetched += 1
      return { ...POST, account }
    }
  })
})

after(async () => {
  await analyst.close()
  await chain.destroy()
})

test('an unknown account is refused before any payment or upstream fetch', async () => {
  const res = await fetch(`${analyst.url}/verdict/elonmusk`)
  assert.equal(res.status, 404)
  assert.equal(fetched, 0)
})

test('an unpaid GET gets 402 and costs the analyst no upstream fetch', async () => {
  const res = await fetch(`${analyst.url}/verdict/WhiteHouse`)
  assert.equal(res.status, 402)
  assert.equal(res.headers.get('x-bsv-sats'), String(PRICE_SATS))
  assert.equal(fetched, 0)
})

test('a paid GET returns the signed post and its verdict, and the analyst keeps the price', async () => {
  const before = await analystWallet.wallet.balance()
  const fetch402 = create402Fetch({ wallet: bindOriginator(agent.wallet, 'agent.treasury-guard.local') })
  const res = await fetch402(`${analyst.url}/verdict/WhiteHouse`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { tweetId: string; label: string; retweet: boolean; signedBy: { airnode: string }; paidSats: number }
  assert.equal(body.tweetId, POST.tweetId)
  assert.equal(body.label, 'risk-off')
  assert.equal(body.retweet, false)
  assert.equal(body.signedBy.airnode, '0xairnode')
  assert.equal(body.paidSats, PRICE_SATS)
  assert.equal(fetched, 1)
  assert.equal(await analystWallet.wallet.balance(), before + PRICE_SATS)
})

const dir = api3Dir()
const fixturePath = path.join(dir, 'test', 'fixtures', 'twitterapi-whitehouse.json')
const ready = existsSync(fixturePath) && existsSync(path.join(dir, 'node_modules', 'viem'))

test('the API3 post source verifies a real signed post and keeps the id a string', { skip: ready ? false : `API3 code not found in ${dir}` }, async () => {
  const response = readFileSync(fixturePath, 'utf8')
  let calls = 0
  const source = api3PostSource({
    payerPrivateKey: 'unused',
    dir,
    fetchFunction: (async () => {
      calls += 1
      return new Response(response, { status: 200 })
    }) as typeof fetch
  })
  const post = await source('WhiteHouse')
  assert.equal(post.tweetId, '2116153357064888354')
  assert.equal(post.retweet, true)
  assert.ok(post.postedAt > 1_700_000_000)
  await source('WhiteHouse')
  assert.equal(calls, 1, 'the second call within a minute is served from the cache')
  await assert.rejects(source('elonmusk'), /not a whitelisted account/)

  const forged = api3PostSource({
    payerPrivateKey: 'unused',
    dir,
    fetchFunction: (async () => new Response(response.replace('CENTCOM', 'CENTCOMM'), { status: 200 })) as typeof fetch
  })
  await assert.rejects(forged('WhiteHouse'), /signed by/)
})
