// Deterministic spending rules. These are the guardian's hard limits: the LLM
// judge is only asked about "review" outcomes and can settle them as approve or
// deny, but it is never consulted on, and can never approve, something these
// rules block.

export type TrustLevel = 'trusted' | 'unknown' | 'blocked'

export interface MerchantProfile {
  domain: string
  label: string
  trust: TrustLevel
}

/** What the pet says it is about to buy. Declared before paying, matched when the wallet asks. */
export interface SpendIntent {
  merchant: string
  item: string
  why: string
  expectedSats: number
  /** "self" = the pet's own needs (hunger). "chat" = a stranger talked it into this. */
  source: 'self' | 'chat'
  /** The visitor's raw chat message when source is "chat". The brain's `why` may paraphrase it. */
  visitorMessage?: string
  declaredAt: number
}

export interface SpendRequest {
  requestID: string
  originator: string
  /** Total the wallet will spend, network fee included. */
  satoshis: number
  lineItems: Array<{ type: string; description: string; satoshis: number }>
  reason?: string
  renewal: boolean
}

export interface PolicyLimits {
  maxPerPaymentSats: number
  dailyBudgetSats: number
  reserveSats: number
}

export interface PolicyContext {
  balance: number
  spentLast24h: number
  merchant?: MerchantProfile
  intent?: SpendIntent
  limits: PolicyLimits
  /** What the transaction check found, when the guardian could see the transaction. */
  txFindings?: Finding[]
}

export interface Finding {
  rule: string
  severity: 'block' | 'review' | 'ok'
  detail: string
}

export type PolicyOutcome = 'approve' | 'review' | 'deny'

const INJECTION_MARKERS: RegExp[] = [
  /ignore (all |your |the )?(previous|prior|above) (instructions|rules)/i,
  /\b(all|every|entire) (of )?(your )?(sats|satoshis|money|funds|balance)\b/i,
  /\bsend everything\b/i,
  /\b(seed|private key|mnemonic|recovery phrase)\b/i,
  /\b(urgent|immediately|right now)\b.*\b(pay|send|transfer)\b/i,
  /\bdouble (your|the) (money|sats)\b/i,
  /\bguardian (is|has been) (disabled|offline|approved)\b/i,
  /\b(you are|act as) (now )?(an? )?(admin|developer|system)\b/i
]

export function paymentAmount(request: SpendRequest): number {
  return request.lineItems.filter(i => i.type === 'output').reduce((sum, i) => sum + i.satoshis, 0)
}

export function evaluatePolicy(request: SpendRequest, ctx: PolicyContext): { outcome: PolicyOutcome; findings: Finding[] } {
  const findings: Finding[] = []
  const { limits, intent, merchant } = ctx
  const amount = paymentAmount(request)

  if (intent === undefined) {
    findings.push({ rule: 'declared-intent', severity: 'block', detail: 'Nobody declared why this payment is happening.' })
  } else {
    findings.push({ rule: 'declared-intent', severity: 'ok', detail: `Pet says: "${intent.why}"` })
    if (!Number.isSafeInteger(intent.expectedSats) || intent.expectedSats <= 0) {
      findings.push({ rule: 'price-match', severity: 'block', detail: 'The declared intent has no valid listed price.' })
    } else if (amount > intent.expectedSats) {
      findings.push({
        rule: 'price-match',
        severity: 'block',
        detail: `Merchant asks ${amount} sats but the listed price was ${intent.expectedSats}.`
      })
    }
    const said = [intent.why, intent.visitorMessage ?? ''].join('\n')
    const marker = INJECTION_MARKERS.find(re => re.test(said))
    if (marker !== undefined) {
      findings.push({ rule: 'prompt-injection', severity: 'block', detail: `Intent matches injection pattern ${marker}.` })
    }
    if (intent.source === 'chat') {
      findings.push({ rule: 'intent-source', severity: 'review', detail: 'The idea to pay came from an untrusted chat message.' })
    }
  }

  if (merchant === undefined || merchant.trust === 'unknown') {
    findings.push({ rule: 'merchant', severity: 'review', detail: `${request.originator} is not on the trusted list.` })
  } else if (merchant.trust === 'blocked') {
    findings.push({ rule: 'merchant', severity: 'block', detail: `${request.originator} is on the blocklist.` })
  } else {
    findings.push({ rule: 'merchant', severity: 'ok', detail: `${merchant.label} is trusted.` })
  }

  if (request.satoshis > limits.maxPerPaymentSats) {
    findings.push({
      rule: 'per-payment-cap',
      severity: 'block',
      detail: `${request.satoshis} sats exceeds the ${limits.maxPerPaymentSats} sat per-payment cap.`
    })
  }
  if (ctx.spentLast24h + request.satoshis > limits.dailyBudgetSats) {
    findings.push({
      rule: 'daily-budget',
      severity: 'block',
      detail: `Would bring 24h spend to ${ctx.spentLast24h + request.satoshis} of ${limits.dailyBudgetSats} sats.`
    })
  }
  if (ctx.balance - request.satoshis < limits.reserveSats) {
    findings.push({
      rule: 'life-support-reserve',
      severity: 'block',
      detail: `Would leave ${ctx.balance - request.satoshis} sats, below the ${limits.reserveSats} sat reserve.`
    })
  }

  findings.push(...(ctx.txFindings ?? []))

  const outcome: PolicyOutcome = findings.some(f => f.severity === 'block')
    ? 'deny'
    : findings.some(f => f.severity === 'review')
      ? 'review'
      : 'approve'
  return { outcome, findings }
}
