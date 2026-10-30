// Step 3 of the H0-H4 plan, part 1. Free: spends nothing.
// Checks that this machine's BSV Desktop answers, which network it is on, and whether it
// can handle the BTMS `p btms` protocol and basket (risk R1).
// Run with BSV Desktop open and unlocked:  npm run desktop:check
import { WalletClient } from '@bsv/sdk'
import { tokenBasket, tokenProtocol } from '../src/token/pusd'

const ORIGINATOR = process.env.MAKER_ORIGINATOR ?? 'maker.agentswap.dev'

async function step(name: string, run: () => Promise<string>): Promise<boolean> {
  try {
    console.log(`OK    ${name}: ${await run()}`)
    return true
  } catch (err) {
    console.log(`FAIL  ${name}: ${(err as Error).message}`)
    return false
  }
}

async function main(): Promise<void> {
  const wallet = new WalletClient('auto', ORIGINATOR)
  console.log(`Talking to BSV Desktop as ${ORIGINATOR}. Approve any prompt it shows.\n`)

  const connected = await step('wallet reachable', async () => {
    const { authenticated } = await wallet.isAuthenticated({})
    return authenticated ? 'authenticated' : 'not authenticated (unlock BSV Desktop)'
  })
  if (!connected) {
    console.log('\nBSV Desktop did not answer. Is it running and unlocked on this machine?')
    return
  }
  await step('network', async () => (await wallet.getNetwork({})).network)
  await step('block height', async () => String((await wallet.getHeight({})).height))
  await step('identity key', async () => (await wallet.getPublicKey({ identityKey: true })).publicKey)

  const protocolOk = await step(`protocol ${JSON.stringify(tokenProtocol())}`, async () =>
    (await wallet.getPublicKey({ protocolID: tokenProtocol(), keyID: 'desktop check', counterparty: 'self' })).publicKey
  )
  const basketOk = await step(`basket "${tokenBasket()}"`, async () =>
    `${(await wallet.listOutputs({ basket: tokenBasket(), limit: 5 })).totalOutputs} outputs`
  )

  console.log('')
  if (protocolOk && basketOk) {
    console.log(`BSV Desktop handles ${JSON.stringify(tokenProtocol())}. Use this setting for the maker smoke test.`)
  } else {
    console.log('BSV Desktop rejected the token protocol or basket. If the errors mention "P-module",')
    console.log('rerun with TOKEN_PROTOCOL set to a name of our own, e.g.')
    console.log('  TOKEN_PROTOCOL="agent swap token" npm run desktop:check')
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
