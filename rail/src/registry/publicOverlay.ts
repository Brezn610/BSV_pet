// The public BTMS overlay. Probed on 2026-10-30: one mainnet host
// (backend.01545c29f0fd3c5cb03921d8b1a3ce01.projects.babbage.systems) serves tm_btms and
// ls_btms; testnet has none. Token transactions must be submitted in order, parents first.
import {
  LookupResolver,
  PushDrop,
  TopicBroadcaster,
  Transaction as Tx,
  Utils,
  type OverlayBroadcastFacilitator,
  type STEAK,
  type TaggedBEEF,
  type Transaction
} from '@bsv/sdk'
import type { Admission } from './localRegistry'

export const BTMS_TOPIC = 'tm_btms'
export const BTMS_LOOKUP = 'ls_btms'

export type OverlayNetwork = 'mainnet' | 'testnet'

/**
 * sdk 3.2.1 sends `X-Topics: tm_btms`; the public host still expects the legacy JSON array
 * and answers 400 ("not valid JSON"), which TopicBroadcaster reports only as
 * ERR_ALL_HOSTS_REJECTED. Verified with spikes/overlay-diagnose.ts.
 */
export class LegacyTopicsFacilitator implements OverlayBroadcastFacilitator {
  async send(url: string, tagged: TaggedBEEF): Promise<STEAK> {
    if (tagged.offChainValues !== undefined) throw new Error('Off-chain values are not supported')
    const response = await fetch(`${url.replace(/\/$/, '')}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Topics': JSON.stringify(tagged.topics) },
      body: new Uint8Array(tagged.beef),
      signal: AbortSignal.timeout(30_000)
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`Overlay host ${url} answered HTTP ${response.status}: ${text.slice(0, 200)}`)
    return JSON.parse(text) as STEAK
  }
}

export async function submitToPublicOverlay(tx: Transaction, network: OverlayNetwork): Promise<{ ok: boolean; detail: string }> {
  const broadcaster = new TopicBroadcaster([BTMS_TOPIC], { networkPreset: network, facilitator: new LegacyTopicsFacilitator() })
  const result = await broadcaster.broadcast(tx)
  return result.status === 'success'
    ? { ok: true, detail: result.message }
    : { ok: false, detail: `${result.code}: ${result.description}` }
}

/** Whether the public overlay holds this token output, as the BTMS library itself checks it. */
export async function isOnPublicOverlay(outpoint: string, network: OverlayNetwork): Promise<boolean> {
  const [txid, outputIndex] = outpoint.split('.')
  const answer = await new LookupResolver({ networkPreset: network }).query({
    service: BTMS_LOOKUP,
    query: { txid, outputIndex: Number(outputIndex) }
  })
  return answer.type === 'output-list' && answer.outputs.length > 0
}

/** The hosts that advertise tm_btms in their SHIP records. */
export async function btmsHosts(network: OverlayNetwork): Promise<string[]> {
  const answer = await new LookupResolver({ networkPreset: network }).query({ service: 'ls_ship', query: { topics: [BTMS_TOPIC] } })
  if (answer.type !== 'output-list') return []
  const hosts = new Set<string>()
  for (const output of answer.outputs) {
    try {
      const { fields } = PushDrop.decode(Tx.fromBEEF(output.beef).outputs[output.outputIndex].lockingScript)
      hosts.add(Utils.toUTF8(fields[2]))
    } catch {
      // Not a SHIP record we can read; skip it.
    }
  }
  return [...hosts]
}

/**
 * The public overlay in the shape of LocalRegistry.submit, for the merchant: submits the
 * transaction and returns what tm_btms admitted. TopicBroadcaster only reports success, but
 * the merchant must know that its own output was admitted. The first host that answers wins.
 */
export class PublicOverlayRegistry {
  constructor(private readonly network: OverlayNetwork) {}

  async submit(tx: Transaction): Promise<Admission> {
    const hosts = await btmsHosts(this.network)
    if (hosts.length === 0) throw new Error(`No ${this.network} host advertises ${BTMS_TOPIC}`)
    const facilitator = new LegacyTopicsFacilitator()
    const errors: string[] = []
    for (const host of hosts) {
      try {
        const steak = await facilitator.send(host, { beef: tx.toBEEF(), topics: [BTMS_TOPIC] })
        const admitted = steak[BTMS_TOPIC]
        if (admitted === undefined) throw new Error(`no ${BTMS_TOPIC} entry in ${JSON.stringify(steak)}`)
        return { outputsToAdmit: admitted.outputsToAdmit, coinsToRetain: admitted.coinsToRetain }
      } catch (err) {
        errors.push(`${host}: ${(err as Error).message}`)
      }
    }
    throw new Error(`Public overlay did not take the transaction. ${errors.join('; ')}`)
  }
}
