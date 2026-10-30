// The public BTMS overlay. Probed on 2026-10-30: on mainnet two hosts advertise tm_btms and
// two advertise ls_btms, and ls_btms answers. Testnet has none. Token transactions must be
// submitted in order, parents first.
import { TopicBroadcaster, type Transaction } from '@bsv/sdk'

export const BTMS_TOPIC = 'tm_btms'
export const BTMS_LOOKUP = 'ls_btms'

export type OverlayNetwork = 'mainnet' | 'testnet'

export async function submitToPublicOverlay(tx: Transaction, network: OverlayNetwork): Promise<{ ok: boolean; detail: string }> {
  const result = await new TopicBroadcaster([BTMS_TOPIC], { networkPreset: network }).broadcast(tx)
  return result.status === 'success'
    ? { ok: true, detail: result.message }
    : { ok: false, detail: `${result.code}: ${result.description}` }
}
