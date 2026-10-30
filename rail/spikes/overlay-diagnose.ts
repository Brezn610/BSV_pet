// Why do the public tm_btms hosts reject our transactions? TopicBroadcaster hides each host's
// answer, so this submits the maker smoke-test transactions (issuance first, then split) to
// every mainnet tm_btms host directly and prints the raw HTTP status and body. It tries both
// X-Topics encodings: the comma form sdk 3.2.1 sends, and the legacy JSON array.
// Run from rail/ after desktop:maker:  npm run diagnose:overlay
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { LookupResolver, PushDrop, Transaction, Utils } from '@bsv/sdk'

const file = process.argv[2] ?? path.join(__dirname, '..', 'data', 'maker-smoke.json')

async function tmBtmsHosts(): Promise<string[]> {
  const answer = await new LookupResolver({ networkPreset: 'mainnet' }).query({ service: 'ls_ship', query: { topics: ['tm_btms'] } })
  if (answer.type !== 'output-list') throw new Error(`Unexpected ls_ship answer: ${answer.type}`)
  const hosts = new Set<string>()
  for (const output of answer.outputs) {
    try {
      const tx = Transaction.fromBEEF(output.beef)
      const { fields } = PushDrop.decode(tx.outputs[output.outputIndex].lockingScript)
      hosts.add(Utils.toUTF8(fields[2]))
    } catch (err) {
      console.log(`  could not decode a SHIP record: ${(err as Error).message}`)
    }
  }
  return [...hosts]
}

async function submit(host: string, beef: number[], topicsHeader: string): Promise<string> {
  try {
    const response = await fetch(`${host.replace(/\/$/, '')}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Topics': topicsHeader },
      body: new Uint8Array(beef),
      signal: AbortSignal.timeout(20_000)
    })
    const text = await response.text()
    return `HTTP ${response.status}  ${text.replace(/\s+/g, ' ').slice(0, 400)}`
  } catch (err) {
    return `request failed: ${(err as Error).message}`
  }
}

async function main(): Promise<void> {
  const saved = JSON.parse(readFileSync(file, 'utf8')) as {
    issued: { beef: number[] }
    split: { pieces: Array<{ beef: number[] }> }
  }
  const txs = [
    { name: 'issuance', tx: Transaction.fromAtomicBEEF(saved.issued.beef) },
    { name: 'split', tx: Transaction.fromAtomicBEEF(saved.split.pieces[0].beef) }
  ]
  const hosts = await tmBtmsHosts()
  console.log(`mainnet tm_btms hosts: ${hosts.join(', ') || '(none)'}\n`)
  for (const { name, tx } of txs) {
    const beef = tx.toBEEF()
    console.log(`${name} ${tx.id('hex')} (${beef.length} bytes of BEEF)`)
    for (const host of hosts) {
      for (const header of ['tm_btms', '["tm_btms"]']) {
        console.log(`  ${host}  X-Topics: ${header}\n    ${await submit(host, beef, header)}`)
      }
    }
    console.log('')
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
