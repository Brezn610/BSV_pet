// Review experiment 2: maker wallet behind WalletPermissionsManager + BTMS P-module (as a BSV Desktop-like host would be).
import test from 'node:test'
import assert from 'node:assert/strict'
import { PushDrop, Script, Transaction, Utils, type WalletProtocol } from '@bsv/sdk'
import { ScriptTemplateBRC29, WalletPermissionsManager, randomBytesHex } from '@bsv/wallet-toolbox'
import { BTMS, BTMSToken } from '@bsv/btms'
import { BasicTokenModule } from '../node_modules/@bsv/btms-permission-module/dist/index.mjs'
import { MockChain } from '../src/chain/mockChain'
import { bindOriginator } from '../src/wallet/agentWallet'

const P: WalletProtocol = [0, 'p btms']
const rand64 = (): string => Utils.toBase64(Utils.toArray(randomBytesHex(32), 'hex'))
const ORIG = 'maker.example.com'

test('maker behind WPM + BasicTokenModule', async t => {
  const chain = await MockChain.create()
  try {
    const maker = await chain.createWallet('maker', 20_000, 2)
    const prompts: string[] = []
    const mod = new BasicTokenModule(async (app: string, msg: string) => { prompts.push(msg.split('\n')[0].slice(0, 60)); return true })
    const noP = (k: string) => ({ [k]: false })
    const wpm = new WalletPermissionsManager(maker.wallet, 'admin.local', {
      seekProtocolPermissionsForSigning: false, seekPermissionsForPublicKeyRevelation: false, seekBasketInsertionPermissions: false,
      seekBasketListingPermissions: false, seekBasketRemovalPermissions: false, seekPermissionWhenApplyingActionLabels: false,
      seekPermissionWhenListingActionsByLabel: false, seekPermissionsForIdentityKeyRevelation: false, seekSpendingPermissions: false,
      encryptWalletMetadata: false, permissionModules: { btms: mod as any }
    } as any)
    const w = bindOriginator(wpm, ORIG) as any
    const btms = new BTMS({ wallet: w, networkPreset: 'local' })
    ;(btms as any).broadcastWithRetry = async () => {}
    const iss = await btms.issue(5, { name: 'pUSD' } as any)
    t.diagnostic(`issue via WPM+module: ${JSON.stringify({ ok: iss.success, err: iss.error })} prompts=${JSON.stringify(prompts)}`)
    assert.ok(iss.success, iss.error)
    const assetId = iss.assetId
    const { tokens } = await btms.getSpendableTokens(assetId)
    t.diagnostic(`listOutputs via module: ${tokens.length} token(s); prompts=${JSON.stringify(prompts)}`)
    const tok = tokens[0]; const meta = tok.token.metadata as string
    const ci = JSON.parse(tok.customInstructions!)
    const tpl = new BTMSToken(w, P)
    const prefix = rand64(); const sufs = [rand64(), rand64()]
    const outs: any[] = []
    for (const [i, s] of sufs.entries()) outs.push({ satoshis: 1, lockingScript: (await tpl.createTransfer(assetId, i === 0 ? 1 : 4, `${prefix} ${s}`, 'self', meta)).toHex(), basket: 'p btms', customInstructions: JSON.stringify({ derivationPrefix: prefix, derivationSuffix: s }), tags: ['btms_type_change', `btms_assetid_${assetId}`], outputDescription: 'offer piece' })
    const beef = (await maker.wallet.listOutputs({ basket: 'p btms', include: 'entire transactions' })).BEEF!
    const c = await w.createAction({ description: 'Split pUSD', inputBEEF: beef, inputs: [{ outpoint: tok.outpoint, unlockingScriptLength: 74, inputDescription: 'issued pUSD' }], outputs: outs, labels: [`p btms assetId ${assetId}`], options: { randomizeOutputs: false } })
    const stx = Transaction.fromAtomicBEEF(c.signableTransaction.tx)
    const un = await tpl.createUnlocker(`${ci.derivationPrefix} ${ci.derivationSuffix}`, 'self').sign(stx, 0)
    const done = await w.signAction({ reference: c.signableTransaction.reference, spends: { 0: { unlockingScript: un.toHex() } } })
    const splitTx = Transaction.fromAtomicBEEF(done.tx)
    t.diagnostic(`split ok txid=${done.txid}; prompts=${JSON.stringify(prompts)}`)

    const presign = async () => {
      const keys = maker.wallet.getClientChangeKeyPair()
      const payLock = new ScriptTemplateBRC29({ derivationPrefix: rand64(), derivationSuffix: rand64(), keyDeriver: maker.wallet.keyDeriver }).lock(keys.privateKey, keys.publicKey)
      const half = new Transaction(1, [], [], 0)
      half.addInput({ sourceTransaction: splitTx, sourceOutputIndex: 0, sequence: 0xffffffff, unlockingScript: new Script() })
      half.addOutput({ satoshis: 5000, lockingScript: payLock })
      return await new PushDrop(w).unlock(P, `${prefix} ${sufs[0]}`, 'self', 'single', true).sign(half, 0)
    }
    try { await presign(); t.diagnostic('presign immediately after split: OK') } catch (e: any) { t.diagnostic(`presign immediately after split: FAILED: ${e.message}`) }
    t.diagnostic('waiting 61s for the module binding to expire...')
    await new Promise(r => setTimeout(r, 61_000))
    const before = prompts.length
    const s = await presign()
    t.diagnostic(`presign after 61s: OK (${s.toHex().length / 2} bytes), new prompts=${JSON.stringify(prompts.slice(before))}`)
  } finally { await (chain as any).destroy?.() }
})
