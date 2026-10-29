import { LookupResolver } from '@bsv/sdk'
async function main() {
  for (const preset of ['mainnet', 'testnet'] as const) {
    const r = new LookupResolver({ networkPreset: preset })
    for (const q of [{ service: 'ls_slap', query: { service: 'ls_btms' } }, { service: 'ls_ship', query: { topics: ['tm_btms'] } }]) {
      try {
        const res: any = await Promise.race([r.query(q as any), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))])
        console.log(preset, q.service, res.type, res.outputs?.length)
      } catch (e: any) { console.log(preset, q.service, 'ERR', e.message?.slice(0, 200)) }
    }
    try {
      const res: any = await Promise.race([r.query({ service: 'ls_btms', query: {} } as any), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000))])
      console.log(preset, 'ls_btms', res.type, res.outputs?.length)
    } catch (e: any) { console.log(preset, 'ls_btms ERR', e.message?.slice(0, 200)) }
  }
}
main()
