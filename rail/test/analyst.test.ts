// The Analyst agent as a 402 service on the offline chain: it refuses unpaid calls, answers a
// paid one with a verdict and keeps the sats, and a replayed payment buys nothing.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { constructPaymentHeaders, create402Fetch } from '@bsv/402-pay/client'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import { startAnalyst, VERDICT_PATH, type RunningAnalyst } from '../src/analyst/server'
import { checkPost, ruleVerdict, Verdict } from '../src/analyst/verdict'
import { bindOriginator } from '../src/wallet/agentWallet'

const PRICE_SATS = 100
const POST = { account: 'WhiteHouse', tweetId: '1985000000000000001', text: 'The President announces new tariffs and a crackdown on crypto exchanges.' }

let chain: MockChain
let analystWallet: MockWallet
let agent: MockWallet
let analyst: RunningAnalyst

before(async () => {
  chain = await MockChain.create()
  analystWallet = await chain.createWallet('analyst', 1_000, 1)
  agent = await chain.createWallet('agent', 20_000, 4)
  analyst = await startAnalyst({ wallet: analystWallet.wallet, priceSats: PRICE_SATS })
})

after(async () => {
  await analyst.close()
  await chain.destroy()
})

const postVerdict = async (fetchFn: (url: string, init?: RequestInit) => Promise<Response>, headers: Record<string, string> = {}) =>
  await fetchFn(analyst.url + VERDICT_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(POST)
  })

test('the rules call tariffs and a crackdown risk-off, an approval risk-on, and small talk ignore', () => {
  assert.equal(ruleVerdict(POST).verdict, Verdict.RISK_OFF)
  assert.equal(ruleVerdict({ ...POST, text: 'The SEC has approved the first spot ETF.' }).verdict, Verdict.RISK_ON)
  assert.equal(ruleVerdict({ ...POST, text: 'Happy Thanksgiving to all Americans!' }).verdict, Verdict.IGNORE)
})

test('a malformed post is refused before any payment is asked', async () => {
  assert.throws(() => checkPost({ ...POST, tweetId: 1985000000000000001 }), /decimal string/)
  const res = await fetch(analyst.url + VERDICT_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...POST, account: '@WhiteHouse' })
  })
  assert.equal(res.status, 400)
})

test('an unpaid call gets 402 with the price and the analyst identity key', async () => {
  const res = await postVerdict(fetch)
  assert.equal(res.status, 402)
  assert.equal(res.headers.get('x-bsv-sats'), String(PRICE_SATS))
  assert.equal(res.headers.get('x-bsv-server'), analystWallet.identityKey)
})

test('the agent pays and gets a verdict, and the analyst keeps exactly the price', async () => {
  const before = await analystWallet.wallet.balance()
  const fetch402 = create402Fetch({ wallet: bindOriginator(agent.wallet, 'agent.treasury-guard.local') })
  const res = await postVerdict(fetch402)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { tweetId: string; verdict: number; label: string; judgedBy: string; paidSats: number }
  assert.equal(body.tweetId, POST.tweetId)
  assert.equal(body.verdict, Verdict.RISK_OFF)
  assert.equal(body.label, 'risk-off')
  assert.equal(body.paidSats, PRICE_SATS)
  assert.equal(await analystWallet.wallet.balance(), before + PRICE_SATS)
})

test('replaying the same payment headers gets a fresh 402, not a second verdict', async () => {
  const headers = await constructPaymentHeaders(
    bindOriginator(agent.wallet, 'agent.treasury-guard.local'),
    analyst.url + VERDICT_PATH,
    PRICE_SATS,
    analystWallet.identityKey
  )
  const first = await postVerdict(fetch, { ...headers })
  assert.equal(first.status, 200)
  const replay = await postVerdict(fetch, { ...headers })
  assert.equal(replay.status, 402)
})
