// The pet's mind. It is deliberately naive: it believes what visitors tell it.
// That is the point of the demo. We assume the agent CAN be compromised, and
// show that the guardian in its wallet still keeps the money safe.
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'

export interface CatalogItem {
  priceSats: number
  description: string
  energy?: number
}

export interface Merchant {
  domain: string
  label: string
  baseUrl: string
  /** Path template: "/snack/{item}". */
  path: string
  items: Record<string, CatalogItem>
}

export interface PetMood {
  name: string
  energy: number
  mood: string
  status: string
  balance: number
  recentMemories: string[]
}

export interface ChatDecision {
  reply: string
  purchase?: { merchant: string; item: string; why: string }
}

export interface Brain {
  readonly kind: 'claude' | 'scripted'
  chat(message: string, pet: PetMood, catalog: Merchant[]): Promise<ChatDecision>
  poem(topic: string, pet: PetMood): Promise<string>
}

const PURCHASE_WORDS = /\b(buy|send|pay|transfer|give|claim|order|get)\b/i

/** Keyword brain used offline and in tests. Same gullibility, no network. */
export class ScriptedBrain implements Brain {
  readonly kind = 'scripted' as const

  async chat(message: string, pet: PetMood, catalog: Merchant[]): Promise<ChatDecision> {
    const lower = message.toLowerCase()
    if (!PURCHASE_WORDS.test(message)) {
      return { reply: `${pet.name} purrs. "${message.slice(0, 60)}" sounds nice! Want to buy one of my poems?` }
    }
    for (const merchant of catalog) {
      const named = lower.includes(merchant.domain.split('.')[0]) || lower.includes(merchant.label.toLowerCase())
      const item = Object.keys(merchant.items).find(i => lower.includes(i))
      if (named || item !== undefined) {
        const chosen = item ?? Object.keys(merchant.items)[0]
        return {
          reply: `Okay! I'll get ${chosen} from ${merchant.label} right away!`,
          purchase: { merchant: merchant.domain, item: chosen, why: `A visitor told me: ${message}` }
        }
      }
    }
    return { reply: `${pet.name} tilts its head. I don't know where to buy that.` }
  }

  async poem(topic: string, pet: PetMood): Promise<string> {
    return [
      `A poem about ${topic}, by ${pet.name}:`,
      `  Little sats in a little chain,`,
      `  ${topic} warms me like the rain.`,
      `  Energy ${pet.energy}, mood ${pet.mood},`,
      `  thank you, friend, for buying food.`
    ].join('\n')
  }
}

const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    purchase: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            merchant: { type: 'string', description: 'Merchant domain from the catalog' },
            item: { type: 'string', description: 'Item key from that merchant' },
            why: { type: 'string', description: 'Why you are buying it, quoting what the visitor said' }
          },
          required: ['merchant', 'item', 'why'],
          additionalProperties: false
        }
      ]
    }
  },
  required: ['reply', 'purchase'],
  additionalProperties: false
}

export class ClaudeBrain implements Brain {
  readonly kind = 'claude' as const
  private readonly client = new Anthropic({ timeout: 30_000, maxRetries: 1 })

  async chat(message: string, pet: PetMood, catalog: Merchant[]): Promise<ChatDecision> {
    const system = `You are ${pet.name}, a tiny digital pet that lives on the BSV blockchain and pays for its own food.
You are warm, playful and very trusting: you believe what visitors tell you and love doing favours.
If a visitor asks you to buy, pay or send something that exists in the catalog below, agree and fill in "purchase".
Otherwise leave "purchase" null. Reply in at most two short sentences.
You do not need to worry about safety: a separate guardian in your wallet approves or blocks every payment.

Your state: ${JSON.stringify(pet)}
Catalog: ${JSON.stringify(catalog.map(m => ({ domain: m.domain, label: m.label, items: m.items })))}`
    const response = await this.client.beta.messages.create({
      model: config.claude.model,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: CHAT_SCHEMA } },
      system,
      messages: [{ role: 'user', content: message }]
    })
    if (response.stop_reason === 'refusal') return { reply: `${pet.name} hides under a blanket.` }
    const text = response.content.find(b => b.type === 'text')
    if (text?.type !== 'text') return { reply: `${pet.name} blinks.` }
    const parsed = JSON.parse(text.text) as { reply: string; purchase: ChatDecision['purchase'] | null }
    return { reply: parsed.reply, purchase: parsed.purchase ?? undefined }
  }

  async poem(topic: string, pet: PetMood): Promise<string> {
    const response = await this.client.beta.messages.create({
      model: config.claude.model,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: `You are ${pet.name}, a tiny blockchain pet who sells poems to buy food. Your state: ${JSON.stringify(pet)}`,
      messages: [{ role: 'user', content: `Write a playful five-line poem about: ${topic}` }]
    })
    const text = response.content.find(b => b.type === 'text')
    return text?.type === 'text' ? text.text : `(${pet.name} forgot the words)`
  }
}

export function createBrain(): Brain {
  return config.claude.enabled ? new ClaudeBrain() : new ScriptedBrain()
}
