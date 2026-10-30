// pUSD on BSV mainnet, one step per command. The owner is BSV Desktop on this machine; the
// reserve, the watcher and the liquidator are server wallets whose root keys live in rail/.env
// (gitignored). Every step that spends needs CONFIRM_MAINNET=1; without it the step only says
// what it would do. State (the book, the reserve token, the vaults) is kept in data/cdp-state.json.
//
//   npm run cdp -- keys                       create the three server wallet keys (free)
//   CONFIRM_MAINNET=1 npm run cdp -- fund     BSV Desktop funds the reserve and the liquidator
//   CONFIRM_MAINNET=1 npm run cdp -- issue    the reserve issues pUSD once, admitted by the public overlay
//   CONFIRM_MAINNET=1 npm run cdp -- lock     BSV Desktop locks collateral in a vault
//   CONFIRM_MAINNET=1 npm run cdp -- mint     signed API3 price + owner's signed request -> pUSD from the reserve
//   CONFIRM_MAINNET=1 npm run cdp -- repay    BSV Desktop sends the debt in pUSD back to the reserve
//   CONFIRM_MAINNET=1 npm run cdp -- withdraw the watcher co-signs the owner's withdrawal once nothing is owed
//   CONFIRM_MAINNET=1 npm run cdp -- liquidate  at the public demo threshold (CDP_DEMO_LIQUIDATION_LTV_BPS)
//   npm run cdp -- status                     what is where, with WhatsOnChain links (free)
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Hash, P2PKH, PrivateKey, Transaction, Utils, WalletClient, type WalletInterface } from '@bsv/sdk'
import { api3PriceSource } from '../src/cdp/api3Price'
import { MintAuthorizer, signMintRequest } from '../src/cdp/authorize'
import {
  COLLATERAL_PROTOCOL,
  WATCHER_PROTOCOL,
  checkLiquidationTx,
  deriveKey,
  liquidateCollateral,
  lockCollateral,
  sighash,
  signDigest,
  withdrawCollateral,
  type LockedCollateral,
  type WatcherApproval
} from '../src/cdp/collateral'
import { DEFAULT_CDP_PARAMS, liquidationPrice, maxMintUsd, type CdpParams } from '../src/cdp/math'
import { PositionBook, USD_PER_PUSD_UNIT } from '../src/cdp/positions'
import { circulatingUnits, issueReserve, receivedToken, transferToken } from '../src/cdp/reserve'
import { openServerWallet, type ServerWallet } from '../src/chain/serverWallet'
import { DATA_DIR, ENV_FILE, loadEnv, requireEnv } from '../src/env'
import { acceptPayment, createInvoice, invoiceTerms } from '../src/merchant/invoice'
import { PublicOverlayRegistry, isOnPublicOverlay } from '../src/registry/publicOverlay'
import { bytes, randomDerivation } from '../src/token/pusd'
import type { OwnedToken } from '../src/token/split'

const ORIGINATOR = process.env.CDP_ORIGINATOR ?? 'pusd.treasuryguard.dev'
const STATE_FILE = path.join(DATA_DIR, 'cdp-state.json')
const KEYS = { reserve: 'CDP_RESERVE_ROOT_KEY_HEX', watcher: 'CDP_WATCHER_ROOT_KEY_HEX', liquidator: 'CDP_LIQUIDATOR_ROOT_KEY_HEX' } as const
/** Mainnet holds real money: keep every amount small. */
const MAX_COLLATERAL_SATS = 2_000_000
const woc = (txid: string): string => `https://whatsonchain.com/tx/${txid}`

interface State {
  reserve?: { token: OwnedToken; total: number; issueTxid: string; returned?: OwnedToken[] }
  book: unknown
  vaults: Record<string, LockedCollateral & { lockTxid: string }>
  ownerTokens: OwnedToken[]
  history: Array<{ at: string; step: string; txid?: string; note: string }>
}

function loadState(): State {
  if (!existsSync(STATE_FILE)) return { book: [], vaults: {}, ownerTokens: [], history: [] }
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State
}

function saveState(state: State): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function record(state: State, step: string, note: string, txid?: string): void {
  state.history.push({ at: new Date().toISOString(), step, txid, note })
  saveState(state)
  console.log(`    ${note}${txid === undefined ? '' : `\n    ${woc(txid)}`}`)
}

function confirmed(what: string): boolean {
  if (process.env.CONFIRM_MAINNET === '1') return true
  console.log(`Would ${what} on BSV mainnet. Rerun with CONFIRM_MAINNET=1 to do it.`)
  return false
}

async function desktop(): Promise<WalletInterface & { identityKey: string }> {
  const wallet = new WalletClient('auto', ORIGINATOR)
  const { network } = await wallet.getNetwork({})
  if (network !== 'mainnet') throw new Error(`BSV Desktop is on ${network}; this flow is mainnet`)
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return Object.assign(wallet, { identityKey: publicKey })
}

async function withServer<T>(role: keyof typeof KEYS, run: (wallet: ServerWallet) => Promise<T>): Promise<T> {
  const wallet = await openServerWallet(`cdp-${role}`, requireEnv(KEYS[role]), DATA_DIR)
  try {
    return await run(wallet)
  } finally {
    await wallet.close()
  }
}

async function vaultKeys(): Promise<{ watcher: string; liquidator: string }> {
  const watcher = await withServer('watcher', async w => (await deriveKey(w.wallet, WATCHER_PROTOCOL, 'vault watcher')).publicKey)
  const liquidator = await withServer('liquidator', async w => (await deriveKey(w.wallet, COLLATERAL_PROTOCOL, 'vault liquidator')).publicKey)
  return { watcher, liquidator }
}

function cmdKeys(): void {
  if (!existsSync(ENV_FILE)) writeFileSync(ENV_FILE, '', { mode: 0o600 })
  for (const [role, name] of Object.entries(KEYS)) {
    const existing = process.env[name]
    if (existing !== undefined && existing !== '') {
      console.log(`${role}: already set, identity ${PrivateKey.fromHex(existing).toPublicKey().toString()}`)
      continue
    }
    const text = readFileSync(ENV_FILE, 'utf8')
    const key = PrivateKey.fromRandom()
    appendFileSync(ENV_FILE, `${text === '' || text.endsWith('\n') ? '' : '\n'}${name}=${key.toHex()}\n`)
    console.log(`${role}: created, identity ${key.toPublicKey().toString()}`)
  }
  chmodSync(ENV_FILE, 0o600)
  console.log(`\nKeys are in ${ENV_FILE}. Never commit, paste or share that file.`)
}

/** BSV Desktop pays a server wallet with BRC-29, which the server wallet takes in. */
async function fundServer(owner: WalletInterface & { identityKey: string }, role: keyof typeof KEYS, satoshis: number, state: State): Promise<void> {
  await withServer(role, async server => {
    const remittance = { derivationPrefix: randomDerivation(), derivationSuffix: randomDerivation() }
    const { publicKey } = await owner.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `${remittance.derivationPrefix} ${remittance.derivationSuffix}`,
      counterparty: server.identityKey
    })
    const lockingScript = new P2PKH().lock(Hash.hash160(Utils.toArray(publicKey, 'hex'))).toHex()
    console.log(`Approve the BSV Desktop prompt: ${satoshis} sats to the ${role}...`)
    const created = await owner.createAction({
      description: `Fund pUSD ${role}`,
      outputs: [{ satoshis, lockingScript, outputDescription: `pUSD ${role} funding` }],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    if (created.tx === undefined || created.txid === undefined) throw new Error('BSV Desktop did not return the transaction')
    const atomicBeef = bytes(created.tx)
    const outputIndex = Transaction.fromAtomicBEEF(atomicBeef).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
    await server.wallet.internalizeAction({
      tx: atomicBeef,
      description: 'Funding from BSV Desktop',
      outputs: [{ outputIndex, protocol: 'wallet payment', paymentRemittance: { ...remittance, senderIdentityKey: owner.identityKey } }]
    })
    record(state, 'fund', `${role} funded with ${satoshis} sats, balance now ${await server.wallet.balance()} sats`, created.txid)
  })
}

async function cmdFund(state: State): Promise<void> {
  const satoshis = Number(process.env.FUND_SATS ?? 5_000)
  if (!Number.isSafeInteger(satoshis) || satoshis <= 0 || satoshis > 50_000) throw new Error(`FUND_SATS must be 1..50000, got ${satoshis}`)
  // FUND_ONLY=reserve or FUND_ONLY=liquidator retries one side without paying the other twice.
  const roles = (process.env.FUND_ONLY === undefined ? ['reserve', 'liquidator'] : [process.env.FUND_ONLY]) as Array<keyof typeof KEYS>
  for (const role of roles) if (role !== 'reserve' && role !== 'liquidator') throw new Error(`FUND_ONLY must be reserve or liquidator, got ${role}`)
  if (!confirmed(`send ${satoshis} sats from BSV Desktop to the ${roles.join(' and the ')}`)) return
  const owner = await desktop()
  for (const role of roles) await fundServer(owner, role, satoshis, state)
}

async function cmdIssue(state: State): Promise<void> {
  if (state.reserve !== undefined) throw new Error(`The reserve already exists (asset ${state.reserve.token.assetId}); pUSD is issued once`)
  const total = Number(process.env.CDP_RESERVE_CENTS ?? 100_000)
  if (!confirmed(`issue ${total} cents of pUSD into the reserve`)) return
  await withServer('reserve', async reserve => {
    const issued = await issueReserve(reserve.wallet, total)
    const admission = await new PublicOverlayRegistry('mainnet').submit(issued.tx)
    if (!admission.outputsToAdmit.includes(0)) throw new Error('The public BTMS overlay did not admit the issuance')
    state.reserve = { token: issued.token, total, issueTxid: issued.tx.id('hex') }
    record(state, 'issue', `reserve issued: ${total} cents, asset ${issued.token.assetId}`, state.reserve.issueTxid)
  })
}

async function cmdLock(state: State): Promise<void> {
  const satoshis = Number(process.env.COLLATERAL_SATS ?? 300_000)
  if (!Number.isSafeInteger(satoshis) || satoshis <= 0 || satoshis > MAX_COLLATERAL_SATS) {
    throw new Error(`COLLATERAL_SATS must be 1..${MAX_COLLATERAL_SATS}, got ${satoshis}`)
  }
  if (!confirmed(`lock ${satoshis} sats from BSV Desktop as pUSD collateral`)) return
  const owner = await desktop()
  const keys = await vaultKeys()
  console.log(`Approve the BSV Desktop prompts: a key for the vault, then ${satoshis} sats...`)
  // The owner fixes where a liquidation must pay their share: a BRC-29 key of their own, checked by the watcher.
  const liquidatorIdentityKey = PrivateKey.fromHex(requireEnv(KEYS.liquidator)).toPublicKey().toString()
  const locked = await lockCollateral(owner, satoshis, keys, { originator: ORIGINATOR, liquidatorIdentityKey })
  const book = PositionBook.fromJSON(state.book)
  book.open(locked.outpoint, owner.identityKey, BigInt(satoshis))
  state.book = book.toJSON()
  state.vaults[locked.outpoint] = { ...locked, lockTxid: locked.outpoint.split('.')[0] }
  record(state, 'lock', `vault ${locked.outpoint} holds ${satoshis} sats`, locked.outpoint.split('.')[0])
}

async function cmdMint(state: State): Promise<void> {
  if (state.reserve === undefined) throw new Error('No reserve yet: run issue first')
  const outpoint = process.env.VAULT ?? Object.keys(state.vaults).at(-1)
  if (outpoint === undefined || state.vaults[outpoint] === undefined) throw new Error('No vault yet: run lock first')
  const payerPrivateKey = process.env.API3_PAYER_KEY
  if (payerPrivateKey === undefined || payerPrivateKey === '') throw new Error('API3_PAYER_KEY is not set: the mint needs a fresh signed API3 price')

  const book = PositionBook.fromJSON(state.book)
  const price = await api3PriceSource({ payerPrivateKey }).latest()
  const room = maxMintUsd(book.get(outpoint), price.value)
  const wanted = process.env.MINT_CENTS === undefined ? room / USD_PER_PUSD_UNIT : BigInt(process.env.MINT_CENTS)
  const amountUsd = wanted * USD_PER_PUSD_UNIT
  console.log(`Signed BSV/USD $${(Number(price.value) / 1e8).toFixed(4)}, room for ${room / USD_PER_PUSD_UNIT} cents; minting ${wanted} cents.`)
  if (wanted <= 0n) throw new Error('Nothing to mint at this price: lock more collateral')
  if (!confirmed(`send ${wanted} cents of pUSD from the reserve to BSV Desktop`)) return

  const owner = await desktop()
  const watcherIdentity = await withServer('watcher', async w => w.identityKey)
  console.log('Approve the BSV Desktop prompt to sign the mint request...')
  const signed = await signMintRequest(
    owner,
    { position: outpoint, amountUsd: amountUsd.toString(), nonce: randomDerivation(), expiresAt: Math.floor(Date.now() / 1000) + 120 },
    watcherIdentity,
    ORIGINATOR
  )
  await withServer('watcher', async w => {
    await new MintAuthorizer(w.wallet).verify(signed, owner.identityKey)
  })
  const units = book.mint(outpoint, owner.identityKey, amountUsd, price)

  const reserveToken = state.reserve.token
  const invoice = await createInvoice(owner, { assetId: reserveToken.assetId, amount: Number(units), metadata: reserveToken.metadata }, { originator: ORIGINATOR })
  await withServer('reserve', async reserve => {
    const transfer = await transferToken(reserve.wallet, reserveToken, invoiceTerms(invoice))
    console.log('Approve the BSV Desktop prompt to take the pUSD in...')
    await acceptPayment(owner, invoice, transfer.atomicBeef, new PublicOverlayRegistry('mainnet'), { originator: ORIGINATOR })
    state.reserve!.token = transfer.change ?? state.reserve!.token
    state.ownerTokens.push(receivedToken(transfer, invoice))
    state.book = book.toJSON()
    record(state, 'mint', `${units} cents of pUSD to the owner against ${outpoint}`, transfer.tx.id('hex'))
  })
}

function vaultOf(state: State): string {
  const outpoint = process.env.VAULT ?? Object.keys(state.vaults).at(-1)
  if (outpoint === undefined || state.vaults[outpoint] === undefined) throw new Error('No vault yet: run lock first')
  return outpoint
}

/** The watcher's key and a signer that runs `check` first, then signs over the exact transaction. */
async function watcherThat(watcher: ServerWallet, check: () => void): Promise<WatcherApproval> {
  const key = await deriveKey(watcher.wallet, WATCHER_PROTOCOL, 'vault watcher')
  return async (tx, inputIndex) => {
    check()
    return await signDigest(watcher.wallet, key, sighash(tx, inputIndex))
  }
}

async function cmdRepay(state: State): Promise<void> {
  if (state.reserve === undefined) throw new Error('No reserve yet')
  const outpoint = vaultOf(state)
  const book = PositionBook.fromJSON(state.book)
  const units = book.get(outpoint).debtUsd / USD_PER_PUSD_UNIT
  if (units === 0n) throw new Error('Nothing is owed on this vault')
  const token = state.ownerTokens.find(t => BigInt(t.amount) >= units)
  if (token === undefined) throw new Error(`BSV Desktop holds no pUSD token of at least ${units} cents`)
  if (!confirmed(`send ${units} cents of pUSD from BSV Desktop back to the reserve`)) return

  const owner = await desktop()
  await withServer('reserve', async reserve => {
    const invoice = await createInvoice(reserve.wallet, { assetId: token.assetId, amount: Number(units), metadata: token.metadata })
    console.log('Approve the BSV Desktop prompt to send the pUSD back...')
    const transfer = await transferToken(owner, token, invoiceTerms(invoice), { originator: ORIGINATOR })
    await acceptPayment(reserve.wallet, invoice, transfer.atomicBeef, new PublicOverlayRegistry('mainnet'))
    book.repay(outpoint, units * USD_PER_PUSD_UNIT)
    state.ownerTokens = state.ownerTokens.filter(t => t.outpoint !== token.outpoint).concat(transfer.change === undefined ? [] : [transfer.change])
    state.reserve!.returned = [...(state.reserve!.returned ?? []), receivedToken(transfer, invoice)]
    state.book = book.toJSON()
    record(state, 'repay', `${units} cents of pUSD back to the reserve; debt now $${(Number(book.get(outpoint).debtUsd) / 1e6).toFixed(2)}`, transfer.tx.id('hex'))
  })
}

async function cmdWithdraw(state: State): Promise<void> {
  const outpoint = vaultOf(state)
  const book = PositionBook.fromJSON(state.book)
  if (book.get(outpoint).debtUsd !== 0n) throw new Error('Repay the debt first: the watcher will not co-sign a withdrawal while pUSD is owed')
  if (!confirmed(`withdraw the collateral of ${outpoint} into BSV Desktop`)) return
  const owner = await desktop()
  await withServer('watcher', async watcher => {
    const approve = await watcherThat(watcher, () => book.close(outpoint, owner.identityKey))
    console.log('Approve the BSV Desktop prompts to take the collateral back...')
    const spent = await withdrawCollateral(owner, state.vaults[outpoint], approve, { originator: ORIGINATOR })
    state.book = book.toJSON()
    record(state, 'withdraw', `collateral of ${outpoint} back in BSV Desktop`, spent.txid)
  })
}

async function cmdLiquidate(state: State): Promise<void> {
  if (state.reserve === undefined) throw new Error('No reserve yet')
  const outpoint = vaultOf(state)
  const payerPrivateKey = process.env.API3_PAYER_KEY
  if (payerPrivateKey === undefined || payerPrivateKey === '') throw new Error('API3_PAYER_KEY is not set: liquidation needs a fresh signed API3 price')
  // A real price will not fall far enough during a two-minute demo, so the demo threshold is lowered
  // in the open: it is printed here and announced to both juries. The mint ceiling stays at 66 %.
  const demoBps = BigInt(process.env.CDP_DEMO_LIQUIDATION_LTV_BPS ?? DEFAULT_CDP_PARAMS.liquidationLtvBps)
  // Mints round down to whole cents, so a demo position can sit below the 66 % ceiling; a demo
  // threshold under the ceiling pulls the ceiling just below it (the book requires mint < liquidation).
  const params: CdpParams = {
    ...DEFAULT_CDP_PARAMS,
    maxMintLtvBps: demoBps <= DEFAULT_CDP_PARAMS.maxMintLtvBps ? demoBps - 1n : DEFAULT_CDP_PARAMS.maxMintLtvBps,
    liquidationLtvBps: demoBps
  }
  console.log(`Liquidation threshold: ${(Number(demoBps) / 100).toFixed(2)} %${demoBps === DEFAULT_CDP_PARAMS.liquidationLtvBps ? '' : ' (PUBLIC DEMO THRESHOLD, not the 75 % rule)'}`)
  const book = PositionBook.fromJSON(state.book, { params })
  const price = await api3PriceSource({ payerPrivateKey }).latest()
  const position = book.get(outpoint)
  const units = position.debtUsd / USD_PER_PUSD_UNIT
  if (book.liquidatable(price).find(p => p.id === outpoint) === undefined) {
    throw new Error(`Not liquidatable at the signed price $${(Number(price.value) / 1e8).toFixed(4)}`)
  }
  const token = state.ownerTokens.find(t => BigInt(t.amount) === units)
  if (token === undefined) throw new Error(`No pUSD token of exactly ${units} cents for the liquidator to buy`)
  if (!confirmed(`liquidate ${outpoint}: the liquidator buys ${units} cents of pUSD from BSV Desktop (the market here), then repays the reserve in one transaction`)) return

  const owner = await desktop()
  await withServer('liquidator', async liquidator =>
    await withServer('watcher', async watcher =>
      await withServer('reserve', async reserve => {
        // The liquidator buys the pUSD it will repay; on mainnet the only holder is BSV Desktop.
        const toBot = await createInvoice(liquidator.wallet, { assetId: token.assetId, amount: Number(units), metadata: token.metadata })
        console.log('Approve the BSV Desktop prompt: the liquidator buys the pUSD...')
        const bought = await transferToken(owner, token, invoiceTerms(toBot), { originator: ORIGINATOR })
        await acceptPayment(liquidator.wallet, toBot, bought.atomicBeef, new PublicOverlayRegistry('mainnet'))
        state.ownerTokens = state.ownerTokens.filter(t => t.outpoint !== token.outpoint)
        record(state, 'buy', `liquidator bought ${units} cents of pUSD`, bought.tx.id('hex'))

        const decided = book.liquidate(outpoint, price)
        const ownerSats = Number(decided.liquidation.ownerSats)
        const repayInvoice = await createInvoice(reserve.wallet, { assetId: token.assetId, amount: Number(units), metadata: token.metadata })
        const expected = {
          assetId: token.assetId,
          debtUnits: Number(units),
          reservePublicKey: repayInvoice.publicKey,
          ownerSats,
          ownerLockingScript: state.vaults[outpoint].payout?.lockingScript,
          // The pUSD that repays the debt must be admitted and unspent on the public BTMS overlay.
          tokenIsLive: async (tokenOutpoint: string) => await isOnPublicOverlay(tokenOutpoint, 'mainnet')
        }
        const approve = await watcherThat(watcher, () => undefined)
        const liquidatorKey = await deriveKey(liquidator.wallet, COLLATERAL_PROTOCOL, 'vault liquidator')
        const done = await liquidateCollateral(
          liquidator.wallet,
          { locked: state.vaults[outpoint], pusd: receivedToken(bought, toBot), reservePublicKey: repayInvoice.publicKey, ownerIdentityKey: owner.identityKey, ownerSats, liquidatorKey },
          async (tx, i) => {
            await checkLiquidationTx(tx, expected)
            return await approve(tx, i)
          }
        )
        await acceptPayment(reserve.wallet, repayInvoice, done.atomicBeef, new PublicOverlayRegistry('mainnet'))
        state.reserve!.returned = [...(state.reserve!.returned ?? []), receivedToken(done, repayInvoice)]
        if (done.payout !== undefined) {
          await owner.internalizeAction(
            { tx: done.atomicBeef, description: 'pUSD liquidation refund', outputs: [{ outputIndex: 1, protocol: 'wallet payment', paymentRemittance: done.payout.remittance }] },
            ORIGINATOR
          )
        }
        state.book = book.toJSON()
        record(state, 'liquidate', `${outpoint} liquidated at $${(Number(price.value) / 1e8).toFixed(4)}: ${units} cents back to the reserve, ${ownerSats} sats to the owner`, done.txid)
      })
    )
  )
}

function cmdStatus(state: State): void {
  const book = PositionBook.fromJSON(state.book)
  console.log(`State file: ${STATE_FILE}`)
  if (state.reserve === undefined) console.log('Reserve: not issued yet')
  else {
    const holdings = [state.reserve.token.amount, ...(state.reserve.returned ?? []).map(t => t.amount)]
    const held = holdings.reduce((sum, amount) => sum + amount, 0)
    console.log(`Reserve: asset ${state.reserve.token.assetId}, holds ${held} of ${state.reserve.total} cents`)
    console.log(`         ${woc(state.reserve.issueTxid)}`)
    console.log(`In circulation: ${circulatingUnits(state.reserve.total, holdings)} cents · debt in the book: $${(Number(book.outstandingUsd()) / 1e6).toFixed(2)}`)
  }
  const last = [...state.history].reverse().find(h => h.step === 'mint')
  console.log(`Positions: ${book.list().length}${last === undefined ? '' : ` (last mint ${last.at})`}`)
  for (const p of book.list()) {
    console.log(`  ${p.id} · ${p.status} · ${p.collateralSats} sats · debt $${(Number(p.debtUsd) / 1e6).toFixed(2)}`)
    const liq = liquidationPrice(p, DEFAULT_CDP_PARAMS)
    if (liq !== undefined) console.log(`    liquidation below $${(Number(liq) / 1e8).toFixed(4)} per BSV`)
  }
  console.log('History:')
  for (const h of state.history) console.log(`  ${h.at} ${h.step.padEnd(5)} ${h.note}${h.txid === undefined ? '' : ` · ${woc(h.txid)}`}`)
}

async function main(): Promise<void> {
  loadEnv()
  const state = loadState()
  const command = process.argv[2] ?? 'status'
  switch (command) {
    case 'keys': return cmdKeys()
    case 'fund': return await cmdFund(state)
    case 'issue': return await cmdIssue(state)
    case 'lock': return await cmdLock(state)
    case 'mint': return await cmdMint(state)
    case 'repay': return await cmdRepay(state)
    case 'withdraw': return await cmdWithdraw(state)
    case 'liquidate': return await cmdLiquidate(state)
    case 'status': return cmdStatus(state)
    default: throw new Error(`Unknown command ${command}: use keys, fund, issue, lock, mint, repay, withdraw, liquidate or status`)
  }
}

main().catch(err => {
  console.error((err as Error).message)
  process.exit(1)
})
