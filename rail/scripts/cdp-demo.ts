// End-to-end story of the BSV-collateralized pUSD on the offline chain, step by step:
// issue the reserve, lock BSV, mint pUSD, the agent pays a 402 service, the price falls, the
// liquidator bot liquidates in one transaction. No real money; every rule is the real code.
// Prices here are typed in by the script; in production they are signed API3 responses.
//
//   npm run demo:cdp
import { create402Fetch } from '@bsv/402-pay/client'
import type { Transaction } from '@bsv/sdk'
import { startAnalyst, VERDICT_PATH } from '../src/analyst/server'
import { MockChain } from '../src/chain/mockChain'
import {
  COLLATERAL_PROTOCOL,
  WATCHER_PROTOCOL,
  checkLiquidationTx,
  deriveKey,
  liquidateCollateral,
  lockCollateral,
  sighash,
  signDigest,
  type WatcherApproval
} from '../src/cdp/collateral'
import { collateralValueUsd, ltvBps, liquidationPrice } from '../src/cdp/math'
import { PositionBook, type SignedPrice } from '../src/cdp/positions'
import { circulatingUnits, issueReserve, receivedToken, transferToken } from '../src/cdp/reserve'
import { acceptPayment, createInvoice, invoiceTerms } from '../src/merchant/invoice'
import { LocalRegistry } from '../src/registry/localRegistry'
import { bindOriginator } from '../src/wallet/agentWallet'

const RESERVE_CENTS = 1_000_000
const COLLATERAL_SATS = 500_000_000

const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 1e6))
const signedPrice = (dollars: number, ageSec = 0): SignedPrice => ({
  value: BigInt(Math.round(dollars * 1e8)),
  signedAt: Math.floor(Date.now() / 1000) - ageSec
})
const dollars = (usd6: bigint): string => `$${(Number(usd6) / 1e6).toFixed(2)}`
const bsv = (sats: number | bigint): string => `${(Number(sats) / 1e8).toFixed(8)} BSV`
const pct = (bps: bigint | undefined): string => (bps === undefined ? 'n/a' : `${(Number(bps) / 100).toFixed(2)} %`)
const short = (txid: string): string => `${txid.slice(0, 10)}…`

let step = 0
const heading = (title: string): void => {
  step += 1
  console.log(`\n── ${step}. ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}
const line = (text: string): void => console.log(`   ${text}`)

async function main(): Promise<void> {
  // Quiet the BTMS registry's notes about plain-sat outputs it skips.
  const original = { log: console.log, debug: console.debug }
  for (const level of ['log', 'debug'] as const) {
    console[level] = (...args: unknown[]): void => {
      if (typeof args[0] === 'string' && args[0].startsWith('[BTMSTopicManager] Skipping output')) return
      original[level](...args)
    }
  }

  heading('Offline chain and the five parties')
  const chain = await MockChain.create()
  const owner = await chain.createWallet('owner', 1_100_000_000, 4)
  const agent = await chain.createWallet('agent', 20_000, 2)
  const analystWallet = await chain.createWallet('analyst', 1_000, 1)
  const reserve = await chain.createWallet('reserve', 20_000, 2)
  const liquidator = await chain.createWallet('liquidator', 20_000, 2)
  const watcher = await chain.createWallet('watcher', 0, 1)
  const registry = new LocalRegistry()
  const book = new PositionBook()
  const watcherKey = await deriveKey(watcher.wallet, WATCHER_PROTOCOL, 'vault watcher')
  const liquidatorKey = await deriveKey(liquidator.wallet, COLLATERAL_PROTOCOL, 'vault liquidator')
  line('owner (BSV Desktop in production), agent, analyst service, pUSD reserve, liquidator bot, watcher')
  line(`rules: mint up to ${pct(book.params.maxMintLtvBps)} LTV, liquidate at ${pct(book.params.liquidationLtvBps)}, bonus ${pct(book.params.liquidationBonusBps)}, prices at most 60 s old`)

  heading('The pUSD reserve is issued once')
  const issued = await issueReserve(reserve.wallet, RESERVE_CENTS)
  await registry.submit(issued.tx)
  let reserveToken = issued.token
  line(`asset ${short(issued.token.assetId)} · ${dollars(BigInt(RESERVE_CENTS) * 10_000n)} of pUSD, all in the reserve`)
  line(`in circulation: ${circulatingUnits(RESERVE_CENTS, [reserveToken.amount])} cents`)

  heading('The owner locks 5 BSV as collateral')
  const price20 = signedPrice(20)
  const locked = await lockCollateral(owner.wallet, COLLATERAL_SATS, { liquidator: liquidatorKey.publicKey, watcher: watcherKey.publicKey })
  book.open(locked.outpoint, owner.identityKey, BigInt(COLLATERAL_SATS))
  line(`vault ${short(locked.outpoint)} · ${bsv(COLLATERAL_SATS)} · worth ${dollars(collateralValueUsd(BigInt(COLLATERAL_SATS), price20.value))} at $20.00 (signed price)`)
  line('script: IF <owner> CHECKSIGVERIFY ELSE <liquidator> CHECKSIGVERIFY ENDIF <watcher> CHECKSIG')

  heading('MINT: the owner takes 60 pUSD from the reserve')
  const units = book.mint(locked.outpoint, owner.identityKey, usd(60), price20)
  const toOwner = await createInvoice(owner.wallet, { assetId: reserveToken.assetId, amount: Number(units), metadata: reserveToken.metadata })
  const mint = await transferToken(reserve.wallet, reserveToken, invoiceTerms(toOwner))
  await acceptPayment(owner.wallet, toOwner, mint.atomicBeef, registry)
  reserveToken = mint.change!
  line(`transfer ${short(mint.tx.id('hex'))} · ${units} cents to the owner, admitted by the BTMS registry`)
  line(`position LTV ${pct(ltvBps(book.get(locked.outpoint), price20.value))} · liquidation price ${dollars((liquidationPrice(book.get(locked.outpoint)) ?? 0n) / 100n)}`)
  line(`in circulation: ${circulatingUnits(RESERVE_CENTS, [reserveToken.amount])} cents`)

  heading('The owner gives the 60 pUSD to its agent as a stable budget')
  const toAgent = await createInvoice(agent.wallet, { assetId: reserveToken.assetId, amount: Number(units), metadata: reserveToken.metadata })
  const funded = await transferToken(owner.wallet, receivedToken(mint, toOwner), invoiceTerms(toAgent))
  await acceptPayment(agent.wallet, toAgent, funded.atomicBeef, registry)
  const agentPusd = receivedToken(funded, toAgent)
  line(`transfer ${short(funded.tx.id('hex'))} · the agent now holds ${agentPusd.amount} cents of pUSD`)

  heading('The book refuses what the rules forbid')
  for (const [label, attempt] of [
    ['mint 10 more pUSD (would pass 66 %)', () => book.mint(locked.outpoint, owner.identityKey, usd(10), price20)],
    ['mint with a price signed 2 minutes ago', () => book.mint(locked.outpoint, owner.identityKey, usd(1), signedPrice(20, 120))],
    ['withdraw the collateral while in debt', () => book.close(locked.outpoint, owner.identityKey)]
  ] as const) {
    try {
      attempt()
      line(`✗ ${label}: allowed (unexpected)`)
    } catch (err) {
      line(`✓ ${label}: refused, ${(err as Error).message}`)
    }
  }

  heading('The agent pays the Analyst agent 100 sats over HTTP 402')
  const analyst = await startAnalyst({ wallet: analystWallet.wallet, priceSats: 100 })
  const fetch402 = create402Fetch({ wallet: bindOriginator(agent.wallet, 'agent.treasury-guard.local') })
  const res = await fetch402(analyst.url + VERDICT_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account: 'WhiteHouse', tweetId: '1985000000000000001', text: 'New tariffs and a crackdown on crypto exchanges announced today.' })
  })
  const verdict = (await res.json()) as { label: string; reason: string; judgedBy: string; paidSats: number }
  line(`paid ${verdict.paidSats} sats · verdict ${verdict.label} (${verdict.judgedBy}): ${verdict.reason}`)
  await analyst.close()

  heading('The signed price falls to $16.00')
  const price16 = signedPrice(16)
  line(`collateral now worth ${dollars(collateralValueUsd(BigInt(COLLATERAL_SATS), price16.value))} · LTV ${pct(ltvBps(book.get(locked.outpoint), price16.value))}`)
  const found = book.liquidatable(price16)
  line(`liquidator bot scans the book: ${found.length} position(s) at or above ${pct(book.params.liquidationLtvBps)}`)

  heading('LIQUIDATE: one atomic BSV transaction')
  // The bot buys the 6,000 cents it will repay on the market: here, from the agent that holds them.
  const toBot = await createInvoice(liquidator.wallet, { assetId: agentPusd.assetId, amount: 6_000, metadata: agentPusd.metadata })
  const bought = await transferToken(agent.wallet, agentPusd, invoiceTerms(toBot))
  await acceptPayment(liquidator.wallet, toBot, bought.atomicBeef, registry)
  const botPusd = receivedToken(bought, toBot)
  line(`the bot buys 60 pUSD on the market (here: from the agent) · ${short(bought.tx.id('hex'))}`)

  const decided = book.liquidate(locked.outpoint, price16)
  const ownerSats = Number(decided.liquidation.ownerSats)
  const repayInvoice = await createInvoice(reserve.wallet, { assetId: botPusd.assetId, amount: 6_000, metadata: botPusd.metadata })
  const expected = { assetId: botPusd.assetId, debtUnits: 6_000, reservePublicKey: repayInvoice.publicKey, ownerSats }
  const watcherSigns: WatcherApproval = async (tx: Transaction, i: number) => {
    checkLiquidationTx(tx, expected)
    return await signDigest(watcher.wallet, watcherKey, sighash(tx, i))
  }
  const plan = { locked, pusd: botPusd, reservePublicKey: repayInvoice.publicKey, ownerIdentityKey: owner.identityKey, ownerSats, liquidatorKey }

  try {
    await liquidateCollateral(liquidator.wallet, { ...plan, ownerSats: ownerSats - 1 }, watcherSigns)
    line('✗ a liquidation that shortchanges the owner went through (unexpected)')
  } catch (err) {
    line(`✓ a liquidation that shortchanges the owner by 1 sat: watcher refused (${(err as Error).message})`)
  }

  const liquidatorBefore = await liquidator.wallet.balance()
  const ownerBefore = await owner.wallet.balance()
  const done = await liquidateCollateral(liquidator.wallet, plan, watcherSigns)
  await acceptPayment(reserve.wallet, repayInvoice, done.atomicBeef, registry)
  await owner.wallet.internalizeAction({
    tx: done.atomicBeef,
    description: 'Liquidation refund',
    outputs: [{ outputIndex: 1, protocol: 'wallet payment', paymentRemittance: done.payout!.remittance }]
  })
  const returned = receivedToken(done, repayInvoice)
  line(`tx ${short(done.txid)}`)
  line(`  output 0 · 6,000 cents of pUSD back to the reserve (admitted by the registry)`)
  line(`  output 1 · ${bsv(ownerSats)} (${dollars(BigInt(ownerSats) * price16.value / 100_000_000_00n)}) to the owner`)
  line(`  change   · ${bsv((await liquidator.wallet.balance()) - liquidatorBefore)} to the liquidator, debt + 5 % less fees`)
  line(`owner received ${bsv((await owner.wallet.balance()) - ownerBefore)}`)

  heading('Where everything ended up')
  line(`position: ${book.get(locked.outpoint).status}, debt ${dollars(book.get(locked.outpoint).debtUsd)}`)
  const circulating = circulatingUnits(RESERVE_CENTS, [reserveToken.amount, returned.amount])
  line(`pUSD in circulation: ${circulating} cents · total debt in the book: ${dollars(book.outstandingUsd())}`)
  line(`${BigInt(circulating) * 10_000n === book.outstandingUsd() ? '✓' : '✗'} every pUSD in circulation is backed by an open position`)

  await chain.destroy()
  Object.assign(console, original)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
