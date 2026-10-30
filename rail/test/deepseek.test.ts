// The DeepSeek judge with a stubbed API: the request it sends, the verdict it reads, and the
// fallback to the rules when the model fails.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzePost, deepseekVerdict, Verdict } from '../src/analyst/verdict'

const post = { account: 'federalreserve', tweetId: '1', text: 'The Federal Reserve announces an emergency rate cut.' }

const answering = (content: string, status = 200): { fetch: typeof fetch; sent: () => Record<string, unknown> } => {
  let body: Record<string, unknown> = {}
  const stub = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status })
  }) as typeof fetch
  return { fetch: stub, sent: () => body }
}

test('DeepSeek is asked for JSON with thinking off, and its label becomes the verdict', async () => {
  const api = answering('{"label":"risk-on","reason":"A rate cut adds liquidity."}')
  const verdict = await deepseekVerdict(post, api.fetch)
  assert.deepEqual(verdict, { verdict: Verdict.RISK_ON, label: 'risk-on', reason: 'A rate cut adds liquidity.', judgedBy: 'deepseek' })
  assert.deepEqual(api.sent().thinking, { type: 'disabled' })
  assert.deepEqual(api.sent().response_format, { type: 'json_object' })
})

test('an unknown label is ignored, and an HTTP error throws', async () => {
  assert.equal((await deepseekVerdict(post, answering('{"label":"buy everything","reason":"x"}').fetch)).verdict, Verdict.IGNORE)
  await assert.rejects(deepseekVerdict(post, answering('', 401).fetch), /HTTP 401/)
})

test('without any model key the rules judge', async () => {
  const saved = { a: process.env.ANTHROPIC_API_KEY, d: process.env.DEEPSEEK_API_KEY }
  delete process.env.DEEPSEEK_API_KEY
  try {
    if (saved.a === undefined) assert.equal((await analyzePost(post)).judgedBy, 'rules')
  } finally {
    if (saved.d !== undefined) process.env.DEEPSEEK_API_KEY = saved.d
  }
})
