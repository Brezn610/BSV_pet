// pUSD is a BTMS token: a 1-sat PushDrop output whose fields are [assetId, amount, metadata].
// Miners do not check those fields; the BTMS registry (tm_btms) does. See docs/verified-facts.md.
import { LockingScript, PushDrop, Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { BTMSToken } from '@bsv/btms'
import { randomBytesHex } from '@bsv/wallet-toolbox'

/**
 * The BTMS protocol. BSV Desktop only accepts it when its BTMS permission module is
 * installed; otherwise set TOKEN_PROTOCOL to a name of our own (security level 1).
 */
export const BTMS_PROTOCOL: WalletProtocol = [0, 'p btms']
export const BTMS_BASKET = 'p btms'

function customProtocol(): string | undefined {
  const custom = process.env.TOKEN_PROTOCOL
  return custom === undefined || custom === '' ? undefined : custom
}

export function tokenProtocol(): WalletProtocol {
  const custom = customProtocol()
  return custom === undefined ? BTMS_PROTOCOL : [1, custom]
}

/**
 * Where token outputs are kept. Basket and label names starting with "p " need the same
 * BTMS permission module, so they switch together with the protocol.
 */
export function tokenBasket(): string {
  return customProtocol() ?? BTMS_BASKET
}

export function tokenLabel(text: string): string {
  return `${customProtocol() === undefined ? 'p btms' : 'agent swap'} ${text}`
}

/** One pUSD unit is one US cent. BTMS amounts are integers, so prices are whole cents. */
export const PUSD_UNIT_USD = 0.01

/** A random base64 derivation component, the shape BTMS uses for keyID halves. */
export function randomDerivation(): string {
  return Utils.toBase64(Utils.toArray(randomBytesHex(32), 'hex'))
}

/** The wallet interface returns BEEF as number[] or Uint8Array; this code passes number[]. */
export function bytes(data: number[] | Uint8Array): number[] {
  return Array.isArray(data) ? data : Array.from(data)
}

export function keyIdOf(prefix: string, suffix: string): string {
  return `${prefix} ${suffix}`
}

/** customInstructions that let the stock BTMS library find and spend a token we inserted ourselves. */
export function btmsCustomInstructions(prefix: string, suffix: string): string {
  return JSON.stringify({ derivationPrefix: prefix, derivationSuffix: suffix })
}

export function btmsTags(kind: 'change' | 'receive', assetId: string): string[] {
  return [`btms_type_${kind}`, `btms_assetid_${assetId}`]
}

/**
 * A BTMS transfer output locked to a public key someone else derived for us, e.g. the
 * per-order key a merchant hands out. Building it needs no signature from anyone.
 */
export async function transferToPublicKey(
  publicKey: string,
  assetId: string,
  amount: number,
  metadata: string | undefined,
  protocol: WalletProtocol = tokenProtocol()
): Promise<LockingScript> {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`Invalid token amount ${amount}`)
  const fields = [Utils.toArray(assetId, 'utf8'), Utils.toArray(String(amount), 'utf8')]
  if (metadata !== undefined) fields.push(Utils.toArray(metadata, 'utf8'))
  // PushDrop.lock only asks the wallet for the locking key; hand it the merchant's key directly.
  const keyOnly = { getPublicKey: async () => ({ publicKey }) } as unknown as WalletInterface
  return await new PushDrop(keyOnly).lock(fields, protocol, 'unused', 'self', false, false)
}

export interface DecodedToken {
  assetId: string
  amount: number
  metadata?: string
  lockingPublicKey: string
}

/** Decodes a BTMS transfer output, or returns undefined if the script is not one. */
export function decodeToken(lockingScriptHex: string): DecodedToken | undefined {
  const decoded = BTMSToken.decode(lockingScriptHex)
  if (!decoded.valid) return undefined
  return {
    assetId: decoded.assetId,
    amount: decoded.amount,
    metadata: decoded.metadata,
    lockingPublicKey: decoded.lockingPublicKey
  }
}
