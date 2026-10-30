// Tunables, overridable from the environment so the demo can be re-paced without code changes.

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`)
  return n
}

export const config = {
  guardian: {
    /** Hard cap on one payment, fee included. */
    maxPerPaymentSats: num('GUARDIAN_MAX_PER_PAYMENT', 50_000),
    /** Rolling 24h spend ceiling across all merchants. */
    dailyBudgetSats: num('GUARDIAN_DAILY_BUDGET', 200_000),
    /** The guardian never lets the agent's balance drop below this. */
    reserveSats: num('GUARDIAN_RESERVE', 1_000)
  },
  claude: {
    /** Without a credential the guardian runs rules only and fails closed on review cases. */
    enabled: process.env.RAIL_LLM !== 'off' && Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN),
    model: process.env.RAIL_MODEL ?? 'claude-opus-5-5'
  }
}

export type Config = typeof config
