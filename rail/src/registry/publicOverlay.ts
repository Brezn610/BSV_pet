// The public BTMS overlay. Probed on 2026-10-30: one mainnet host
// (backend.01545c29f0fd3c5cb03921d8b1a3ce01.projects.babbage.systems) serves tm_btms and
// ls_btms; testnet has none. Token transactions must be submitted in order, parents first.
import {
  LookupResolver,
  TopicBroadcaster,
  type OverlayBroadcastFacilitator,
  type STEAK,
  type TaggedBEEF,
  type Transaction
} from '@bsv/sdk'

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
