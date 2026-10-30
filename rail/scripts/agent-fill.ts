// Step 4, part 2: the first real swap-and-pay on mainnet. Spends about the offer price plus a
// small fee from the agent's server wallet.
// The agent takes the offer saved by desktop:maker, through its guarded wallet, and pays the
// merchant's invoice in pUSD. The merchant has the public overlay admit the payment and takes
// it in. The maker (BSV Desktop) then collects its sats.
// Progress is saved to data/fill-<offer>.json, so a rerun resumes after the fill instead of filling again.
// For another fill, pre-sign a new offer first with desktop:offer.
// Run from rail/ after agent:fund:  CONFIRM_MAINNET=1 npm run agent:fill
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { WalletClient } from '@bsv/sdk'
import { openServerWallet } from '../src/chain/serverWallet'
import { config } from '../src/config'
import { DATA_DIR, loadEnv, requireEnv } from '../src/env'
import { EventBus } from '../src/events'
import { Guardian, type JournalEntry } from '../src/guardian/guardian'
import { swapPayPlan } from '../src/guardian/txCheck'
import { TxObserver } from '../src/guardian/txObserver'
import { acceptPayment, createInvoice, invoiceTerms, paymentLockingScript, type Invoice } from '../src/merchant/invoice'
import { LocalRegistry } from '../src/registry/localRegistry'
import { isOnPublicOverlay, PublicOverlayRegistry } from '../src/registry/publicOverlay'
import { fillOffer, previewFill } from '../src/swap/fill'
import { checkOffer, collectProceeds, type SignedOffer } from '../src/swap/offer'
import { tokenProtocol } from '../src/token/pusd'
import { bindOriginator, createGuardedWallet } from '../src/wallet/agentWallet'

const MERCHANT = process.env.MERCHANT_DOMAIN ?? 'shop.agentswap.dev'
const MAKER_FILE = path.join(DATA_DIR, 'maker-smoke.json')

interface Progress {
  offerOutpoint: string
  invoice: Invoice
  txid: string
  atomicBeef: number[]
  filledAt: number
  merchantAccepted?: boolean
  makerCollected?: boolean
}

const woc = (txid: string): string => `https://whatsonchain.com/tx/${txid}`

/** One progress file per offer, so a new offer from desktop:offer starts fresh. */
const progressFile = (outpoint: string): string => path.join(DATA_DIR, `fill-${outpoint}.json`)

function save(progress: Progress): void {
  writeFileSync(progressFile(progress.offerOutpoint), JSON.stringify(progress, null, 2))
}

async function main(): Promise<void> {
  loadEnv()
  if (process.env.CONFIRM_MAINNET !== '1') {
    console.log('This fills a real offer on mainnet with the agent wallet. Rerun with CONFIRM_MAINNET=1.')
    return
  }
  const saved = JSON.parse(readFileSync(MAKER_FILE, 'utf8')) as { network: string; originator: string; protocol: unknown; offer: SignedOffer }
  if (saved.network !== 'mainnet') throw new Error(`${MAKER_FILE} is from ${saved.network}, not mainnet`)
  if (JSON.stringify(saved.protocol) !== JSON.stringify(tokenProtocol())) {
    throw new Error(`The offer uses token protocol ${JSON.stringify(saved.protocol)}; set TOKEN_PROTOCOL the same way as for desktop:maker`)
  }
  const offer = saved.offer

  const agent = await openServerWallet('agent', requireEnv('AGENT_ROOT_KEY_HEX'), DATA_DIR)
  const merchant = await openServerWallet('merchant', requireEnv('MERCHANT_ROOT_KEY_HEX'), DATA_DIR)
  try {
    // The first mainnet fill kept its progress in fill.json.
    const file = [progressFile(offer.outpoint), path.join(DATA_DIR, 'fill.json')].find(
      f => existsSync(f) && (JSON.parse(readFileSync(f, 'utf8')) as Progress).offerOutpoint === offer.outpoint
    )
    let progress: Progress | undefined = file === undefined ? undefined : (JSON.parse(readFileSync(file, 'utf8')) as Progress)

    if (progress === undefined) {
      console.log(`Agent ${agent.identityKey}: ${await agent.wallet.balance()} sats.`)
      console.log(`1/6 Checking offer ${offer.outpoint}: ${offer.amount} pUSD for ${offer.priceSats} sats...`)
      const check = checkOffer(offer)
      if (!check.ok) throw new Error(`Offer rejected: ${check.reason}`)
      // The lookup also finds spent outputs; a spent offer is caught as a double spend at step 4.
      if (!(await isOnPublicOverlay(offer.outpoint, 'mainnet'))) throw new Error('The public overlay does not know the offered token')
      console.log('    maker signature valid, token known to the public overlay')

      console.log(`2/6 Merchant ${MERCHANT} issues an invoice for ${offer.amount} pUSD...`)
      const invoice = await createInvoice(merchant.wallet, { assetId: offer.assetId, amount: offer.amount, metadata: offer.metadata, ttlMs: 30 * 60_000 })
      const merchantLock = await paymentLockingScript(invoiceTerms(invoice))

      console.log('3/6 Previewing the BTMS rules on the fill before signing...')
      const registry = new LocalRegistry()
      registry.trust(offer.outpoint, offer.beef)
      const preview = await previewFill(offer, merchantLock, registry)
      if (!preview.merchantOutputAdmitted) throw new Error(`The merchant's pUSD would not be admitted: ${JSON.stringify(preview.admission)}`)
      console.log('    the merchant output would be admitted')

      console.log('4/6 Agent fills the offer through its guarded wallet; the guardian checks the transaction...')
      const observer = new TxObserver()
      const guarded = createGuardedWallet(agent.wallet, observer)
      const events = new EventBus()
      events.subscribe(event => {
        console.log(`    [guardian] ${event.message}`)
        if (event.type !== 'guardian.decision') return
        for (const f of (event.data as JournalEntry).verdict.findings) {
          if (f.rule.startsWith('tx-')) console.log(`    [guardian]   ${f.severity === 'ok' ? 'ok' : f.severity.toUpperCase()}: ${f.detail}`)
        }
      })
      const guardian = new Guardian({
        manager: guarded,
        wallet: agent.wallet,
        events,
        limits: config.guardian,
        issueAllowances: false,
        merchants: [{ domain: MERCHANT, label: 'Demo merchant', trust: 'trusted' }],
        useClaude: false,
        observer
      })
      guardian.start()
      await guardian.declareIntent({
        merchant: MERCHANT,
        item: `${offer.amount} pUSD for one API call`,
        why: 'Mainnet test of the swap-and-pay rail',
        // Output line items: the maker's price plus the merchant's 1-sat token output.
        expectedSats: offer.priceSats + 1,
        source: 'self'
      }, await swapPayPlan(offer, invoiceTerms(invoice)))
      const fill = await fillOffer(bindOriginator(guarded, MERCHANT), offer, merchantLock).finally(() => guardian.clearIntent(MERCHANT))
      progress = { offerOutpoint: offer.outpoint, invoice, txid: fill.txid, atomicBeef: fill.atomicBeef, filledAt: Date.now() }
      save(progress)
      console.log(`    ${woc(fill.txid)}`)
    } else {
      console.log(`Resuming after fill ${progress.txid}.`)
    }

    if (progress.merchantAccepted !== true) {
      console.log('5/6 Merchant verifies the payment, has the public overlay admit it, and takes it in...')
      const accepted = await acceptPayment(merchant.wallet, progress.invoice, progress.atomicBeef, new PublicOverlayRegistry('mainnet'), {
        chainTracker: await merchant.services.getChainTracker(),
        // A rerun may come after the invoice expired; what counts is when the agent paid.
        now: progress.filledAt
      })
      progress.merchantAccepted = true
      save(progress)
      console.log(`    pUSD received at output ${accepted.outputIndex}`)
    }

    if (progress.makerCollected !== true && process.env.MAKER_COLLECT !== 'off') {
      console.log(`6/6 Maker collects ${offer.priceSats} sats in BSV Desktop; approve the prompt...`)
      const maker = new WalletClient('auto', saved.originator)
      await collectProceeds(maker, offer, progress.atomicBeef, { originator: saved.originator })
      progress.makerCollected = true
      save(progress)
      console.log('    collected')
    }

    console.log(`\nDone. Fill: ${woc(progress.txid)}`)
    console.log(`Agent balance now ${await agent.wallet.balance()} sats.`)
  } finally {
    await agent.close()
    await merchant.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
