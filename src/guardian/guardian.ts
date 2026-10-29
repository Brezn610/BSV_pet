// The Guardian agent lives inside the pet's wallet. It answers every spending
// authorization request the WalletPermissionsManager raises, and keeps a
// hash-chained journal of its decisions whose head is anchored in the pet's
// on-chain soul token.
import { Hash, Utils } from '@bsv/sdk'
import type { Wallet, WalletPermissionsManager } from '@bsv/wallet-toolbox'
import type { EventBus } from '../events'
import { judgeWithClaude } from './llmJudge'
import {
  evaluatePolicy,
  paymentAmount,
  type Finding,
  type MerchantProfile,
  type PolicyContext,
  type PolicyLimits,
  type SpendIntent,
  type SpendRequest
} from './policy'

export interface Verdict {
  decision: 'approve' | 'deny'
  /** "once" = ephemeral grant. "allowance" = recurring on-chain DSAP token for a trusted merchant. */
  mode: 'once' | 'allowance'
  allowanceSats?: number
  risk: number
  reasons: string[]
  judge: 'rules' | 'claude'
  findings: Finding[]
}

export interface JournalEntry {
  seq: number
  at: string
  merchant: string
  satoshis: number
  intent?: SpendIntent
  verdict: Verdict
  prevHash: string
  hash: string
}

export interface GuardianOptions {
  manager: WalletPermissionsManager
  wallet: Wallet
  events: EventBus
  limits: PolicyLimits
  trustedAllowanceSats: number
  merchants: MerchantProfile[]
  useClaude: boolean
}

const GENESIS = '00'.repeat(32)

export class Guardian {
  private readonly intents = new Map<string, SpendIntent>()
  /**
   * Balance captured when an intent is declared. While a payment is being built
   * the wallet has already locked its inputs, so asking for the balance from
   * inside the authorization callback would report the locked coins as gone.
   */
  private balanceSnapshot = 0
  private readonly merchants = new Map<string, MerchantProfile>()
  private readonly settled: Array<{ at: number; sats: number }> = []
  readonly journal: JournalEntry[] = []

  constructor(private readonly opts: GuardianOptions) {
    for (const m of opts.merchants) this.merchants.set(m.domain, m)
  }

  start(): void {
    this.opts.manager.bindCallback('onSpendingAuthorizationRequested', async (req: any) => {
      await this.handle(req)
    })
  }

  get journalRoot(): string {
    return this.journal.at(-1)?.hash ?? GENESIS
  }

  get limits(): PolicyLimits {
    return this.opts.limits
  }

  merchantList(): MerchantProfile[] {
    return [...this.merchants.values()]
  }

  /** The pet must say what it is buying before it pays. Undeclared spends are denied. */
  async declareIntent(intent: Omit<SpendIntent, 'declaredAt'>): Promise<void> {
    this.balanceSnapshot = await this.opts.wallet.balance()
    this.intents.set(intent.merchant, { ...intent, declaredAt: Date.now() })
  }

  clearIntent(merchant: string): void {
    this.intents.delete(merchant)
  }

  recordSettled(sats: number): void {
    this.settled.push({ at: Date.now(), sats })
  }

  spentLast24h(): number {
    const since = Date.now() - 24 * 3600 * 1000
    return this.settled.filter(s => s.at >= since).reduce((sum, s) => sum + s.sats, 0)
  }

  /** On-chain allowances (DSAP tokens) currently held for trusted merchants. */
  async allowances(): Promise<Array<{ merchant: string; txid: string; authorizedSats: number }>> {
    const out: Array<{ merchant: string; txid: string; authorizedSats: number }> = []
    for (const m of this.merchants.values()) {
      const tokens = await this.opts.manager.listSpendingAuthorizations({ originator: m.domain })
      for (const t of tokens) out.push({ merchant: m.domain, txid: t.txid, authorizedSats: t.authorizedAmount ?? 0 })
    }
    return out
  }

  private async handle(req: any): Promise<void> {
    const request: SpendRequest = {
      requestID: req.requestID,
      originator: req.originator,
      satoshis: req.spending?.satoshis ?? 0,
      lineItems: req.spending?.lineItems ?? [],
      reason: req.reason,
      renewal: Boolean(req.renewal)
    }
    const intent = this.intents.get(request.originator)
    this.opts.events.emit(
      'guardian.request',
      `${request.originator} asks for ${request.satoshis} sats${request.renewal ? ' (allowance renewal)' : ''}`,
      { request, intent }
    )

    let verdict: Verdict
    try {
      verdict = await this.decide(request, intent)
    } catch (err) {
      // Fail closed: if the guardian cannot think, nobody gets paid.
      verdict = {
        decision: 'deny',
        mode: 'once',
        risk: 100,
        reasons: [`Guardian error, failing closed: ${(err as Error).message}`],
        judge: 'rules',
        findings: []
      }
    }

    if (verdict.decision === 'approve') {
      try {
        await this.opts.manager.grantPermission({
          requestID: request.requestID,
          ephemeral: verdict.mode === 'once',
          amount: verdict.allowanceSats
        })
      } catch (err) {
        // The manager releases the payment before minting the allowance token,
        // so a failed mint only downgrades this approval to a one-off.
        verdict.mode = 'once'
        verdict.reasons.push(`Allowance token could not be minted (${(err as Error).message}); approved once instead.`)
      }
    } else {
      await this.opts.manager.denyPermission(request.requestID)
    }
    const entry = this.append(request, intent, verdict)
    this.opts.events.emit(
      'guardian.decision',
      `${verdict.decision === 'approve' ? 'APPROVED' : 'DENIED'} ${request.satoshis} sats to ${request.originator}: ${verdict.reasons[0]}`,
      entry
    )
  }

  private async decide(request: SpendRequest, intent: SpendIntent | undefined): Promise<Verdict> {
    const merchant = this.merchants.get(request.originator)
    const ctx: PolicyContext = {
      balance: this.balanceSnapshot,
      spentLast24h: this.spentLast24h(),
      merchant,
      intent,
      limits: this.opts.limits
    }
    const { outcome, findings } = evaluatePolicy(request, ctx)
    const details = (severity: Finding['severity']): string[] =>
      findings.filter(f => f.severity === severity).map(f => f.detail)

    if (outcome === 'deny') {
      const injection = findings.some(f => f.rule === 'prompt-injection')
      return { decision: 'deny', mode: 'once', risk: injection ? 95 : 70, reasons: details('block'), judge: 'rules', findings }
    }

    if (outcome === 'approve') {
      const allowance = this.opts.trustedAllowanceSats
      if (merchant?.trust === 'trusted' && intent?.source === 'self' && allowance > 0) {
        return {
          decision: 'approve',
          mode: 'allowance',
          allowanceSats: Math.max(allowance, request.satoshis),
          risk: 5,
          reasons: [`Trusted merchant; issuing an on-chain allowance of ${Math.max(allowance, request.satoshis)} sats.`],
          judge: 'rules',
          findings
        }
      }
      return {
        decision: 'approve',
        mode: 'once',
        risk: 10,
        reasons: [`${paymentAmount(request)} sats for "${intent?.item}" passes every rule.`],
        judge: 'rules',
        findings
      }
    }

    // outcome === 'review'
    if (!this.opts.useClaude) {
      return {
        decision: 'deny',
        mode: 'once',
        risk: 60,
        reasons: ['Needs review and no judge model is configured, so the guardian fails closed.', ...details('review')],
        judge: 'rules',
        findings
      }
    }
    const judged = await judgeWithClaude(request, ctx, findings)
    return {
      decision: judged.decision,
      mode: 'once',
      risk: judged.risk,
      reasons: [judged.explanation, ...details('review')],
      judge: 'claude',
      findings
    }
  }

  private append(request: SpendRequest, intent: SpendIntent | undefined, verdict: Verdict): JournalEntry {
    const prevHash = this.journalRoot
    const body = {
      seq: this.journal.length + 1,
      at: new Date().toISOString(),
      merchant: request.originator,
      satoshis: request.satoshis,
      intent,
      verdict
    }
    const hash = Utils.toHex(Hash.sha256(Utils.toArray(prevHash + JSON.stringify(body), 'utf8')))
    const entry: JournalEntry = { ...body, prevHash, hash }
    this.journal.push(entry)
    return entry
  }
}
