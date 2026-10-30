// MINT needs the owner's say-so. Without it, anyone who knows a collateral outpoint could mint
// against it up to the ceiling and then liquidate it for the bonus. The owner signs the exact
// request in their own wallet (BSV Desktop in production) for the watcher's identity key; the
// watcher verifies it, refuses expired or reused requests, and only then releases pUSD.
import { Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk'

export const MINT_PROTOCOL: WalletProtocol = [1, 'pusd mint request']

export interface MintRequest {
  /** The collateral outpoint the position is keyed on. */
  position: string
  /** USD with 6 decimals, as a decimal string so it survives JSON. */
  amountUsd: string
  /** Unique per request; also the key ID the signature is made with. */
  nonce: string
  /** Unix seconds after which the watcher refuses the request. */
  expiresAt: number
}

export interface SignedMintRequest {
  request: MintRequest
  /** The owner's identity key. */
  owner: string
  signature: number[]
}

/** The exact bytes that are signed: fixed key order, no whitespace. */
export function mintRequestBytes(request: MintRequest): number[] {
  const { position, amountUsd, nonce, expiresAt } = request
  return Utils.toArray(JSON.stringify({ position, amountUsd, nonce, expiresAt }), 'utf8')
}

export async function signMintRequest(
  owner: WalletInterface,
  request: MintRequest,
  watcherIdentityKey: string,
  originator?: string
): Promise<SignedMintRequest> {
  const { publicKey } = await owner.getPublicKey({ identityKey: true }, originator)
  const { signature } = await owner.createSignature(
    { data: mintRequestBytes(request), protocolID: MINT_PROTOCOL, keyID: request.nonce, counterparty: watcherIdentityKey },
    originator
  )
  return { request, owner: publicKey, signature: Array.from(signature) }
}

/** The watcher's check. Throws on anything it should not act on; returns the amount otherwise. */
export class MintAuthorizer {
  private readonly used = new Set<string>()

  constructor(
    private readonly watcher: WalletInterface,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly originator?: string
  ) {}

  async verify(signed: SignedMintRequest, expectedOwner: string): Promise<bigint> {
    const { request } = signed
    if (signed.owner !== expectedOwner) throw new Error('mint request is not from the position owner')
    if (request.expiresAt < this.now()) throw new Error('mint request has expired')
    if (this.used.has(request.nonce)) throw new Error('mint request was already used')
    if (!/^[0-9]+$/.test(request.amountUsd)) throw new Error('mint amount must be a whole number of USD micro-units')
    let valid = false
    try {
      ;({ valid } = await this.watcher.verifySignature(
        {
          data: mintRequestBytes(request),
          signature: signed.signature,
          protocolID: MINT_PROTOCOL,
          keyID: request.nonce,
          counterparty: signed.owner
        },
        this.originator
      ))
    } catch {
      valid = false
    }
    if (!valid) throw new Error('mint request signature is invalid')
    this.used.add(request.nonce)
    return BigInt(request.amountUsd)
  }
}
