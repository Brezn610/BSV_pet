// Step 4, part 1. BSV Desktop pays the agent's mainnet server wallet with a BRC-29 payment,
// which the agent's wallet then takes in. Without CONFIRM_MAINNET=1 it only prints the balance.
// Run from rail/ after keys:init:  CONFIRM_MAINNET=1 npm run agent:fund
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Hash, P2PKH, Transaction, Utils, WalletClient } from '@bsv/sdk'
import { openServerWallet } from '../src/chain/serverWallet'
import { DATA_DIR, loadEnv, requireEnv } from '../src/env'
import { bytes, randomDerivation } from '../src/token/pusd'

const FUNDER_ORIGINATOR = process.env.FUNDER_ORIGINATOR ?? 'maker.agentswap.dev'
const FUND_SATS = Number(process.env.FUND_SATS ?? 20_000)

async function main(): Promise<void> {
  loadEnv()
  const agent = await openServerWallet('agent', requireEnv('AGENT_ROOT_KEY_HEX'), DATA_DIR)
  try {
    console.log(`Agent identity ${agent.identityKey}, balance ${await agent.wallet.balance()} sats.`)
    if (process.env.CONFIRM_MAINNET !== '1') {
      console.log(`To send it ${FUND_SATS} sats from BSV Desktop, rerun with CONFIRM_MAINNET=1 (FUND_SATS changes the amount).`)
      return
    }
    if (!Number.isSafeInteger(FUND_SATS) || FUND_SATS <= 0) throw new Error(`Invalid FUND_SATS ${FUND_SATS}`)

    const desktop = new WalletClient('auto', FUNDER_ORIGINATOR)
    const { network } = await desktop.getNetwork({})
    if (network !== 'mainnet') throw new Error(`BSV Desktop is on ${network}; the agent wallet is mainnet`)
    const { publicKey: senderIdentityKey } = await desktop.getPublicKey({ identityKey: true })
    const remittance = { derivationPrefix: randomDerivation(), derivationSuffix: randomDerivation() }
    // BRC-29: the sender derives the agent's key with the agent as counterparty.
    const { publicKey } = await desktop.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `${remittance.derivationPrefix} ${remittance.derivationSuffix}`,
      counterparty: agent.identityKey
    })
    const lockingScript = new P2PKH().lock(Hash.hash160(Utils.toArray(publicKey, 'hex'))).toHex()

    console.log(`Approve the BSV Desktop prompt to send ${FUND_SATS} sats...`)
    const created = await desktop.createAction({
      description: 'Fund agent wallet',
      outputs: [{ satoshis: FUND_SATS, lockingScript, outputDescription: 'agent wallet funding' }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    if (created.tx === undefined || created.txid === undefined) throw new Error('BSV Desktop did not return the transaction')
    const atomicBeef = bytes(created.tx)
    const outputIndex = Transaction.fromAtomicBEEF(atomicBeef).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
    console.log(`    https://whatsonchain.com/tx/${created.txid}`)

    // Saved first, so the payment can still be taken in by hand if the next step fails.
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(
      path.join(DATA_DIR, `funding-${created.txid}.json`),
      JSON.stringify({ txid: created.txid, outputIndex, senderIdentityKey, remittance, atomicBeef })
    )
    await agent.wallet.internalizeAction({
      tx: atomicBeef,
      description: 'Funding from BSV Desktop',
      outputs: [{ outputIndex, protocol: 'wallet payment', paymentRemittance: { ...remittance, senderIdentityKey } }]
    })
    console.log(`Agent balance now ${await agent.wallet.balance()} sats.`)
  } finally {
    await agent.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
