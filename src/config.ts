// All tunables in one place. Every value can be overridden from the environment
// so the demo can be re-paced on stage without touching code.

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`)
  return n
}

export const config = {
  port: num('PORT', 4000),
  snackShopPort: num('SNACK_SHOP_PORT', 4001),
  scamShopPort: num('SCAM_SHOP_PORT', 4002),

  /** "mock" runs a private offline chain. "live" is the testnet/mainnet path (see README). */
  mode: (process.env.SATSPET_MODE ?? 'mock') as 'mock' | 'live',

  pet: {
    name: process.env.PET_NAME ?? 'Satoshi-chan',
    startingSats: num('PET_STARTING_SATS', 10_000),
    /** How often the pet gets hungrier, in ms. 0 disables the automatic heartbeat. */
    tickMs: num('PET_TICK_MS', 15_000),
    energyPerTick: num('PET_ENERGY_PER_TICK', 6),
    hungryBelow: num('PET_HUNGRY_BELOW', 45),
    poemPriceSats: num('PET_POEM_PRICE_SATS', 80)
  },

  guardian: {
    /** Hard cap on one payment, fee included. */
    maxPerPaymentSats: num('GUARDIAN_MAX_PER_PAYMENT', 500),
    /** Rolling 24h spend ceiling across all merchants. */
    dailyBudgetSats: num('GUARDIAN_DAILY_BUDGET', 2_000),
    /** The guardian never lets the balance drop below this: it is the pet's life support. */
    reserveSats: num('GUARDIAN_RESERVE', 300),
    /**
     * Approvals for trusted merchants are recorded as an on-chain allowance (a BRC-73 DSAP token)
     * sized to exactly what has been approved, so every payment still reaches the guardian.
     * "off" approves them once instead.
     */
    issueAllowances: process.env.GUARDIAN_ALLOWANCES !== 'off'
  },

  claude: {
    /** Without a credential both agents fall back to deterministic logic, so the demo never depends on wifi. */
    enabled: process.env.SATSPET_LLM !== 'off' && Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN),
    model: process.env.SATSPET_MODEL ?? 'claude-opus-5-5'
  }
}

export type Config = typeof config
