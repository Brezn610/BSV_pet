// Review experiment: BTMS (PushDrop) swap-and-pay, offline, pinned sdk 3.2.1 / toolbox 2.14.9 / btms 1.2.6.
// Run from rail/: npm run spike
import test from 'node:test'
import assert from 'node:assert/strict'
import { Beef, PushDrop, Script, Transaction, Utils, type WalletProtocol } from '@bsv/sdk'
import { ScriptTemplateBRC29, randomBytesHex } from '@bsv/wallet-toolbox'
import { BTMS, BTMSToken } from '@bsv/btms'
import { MockChain } from '../src/chain/mockChain'
import { bindOriginator, createGuardedWallet } from '../src/wallet/agentWallet'
import BTMSTopicManager from '../src/registry/BTMSTopicManager'

const P: WalletProtocol = [0, 'p btms']
const rand64 = (): string => Utils.toBase64(Utils.toArray(randomBytesHex(32), 'hex'))
const N = 5000

/** Minimal local overlay for tm_btms: tracks admitted outpoints + BEEF, runs the real BTMSTopicManager. */
class LocalOverlay {
  tm = new BTMSTopicManager()
  admitted = new Map<string, number[]>() // outpoint -> beef of its tx
  spent = new Set<string>()
  log: string[] = []
  async submit(tx: Transaction, label: string) {
    const beef = tx.toBEEF()
    const prev: number[] = []
    tx.inputs.forEach((inp, i) => {
      const op = `${inp.sourceTXID ?? inp.sourceTransaction!.id('hex')}.${inp.sourceOutputIndex}`
      if (this.admitted.has(op)) prev.push(i)
    })
    const r = await this.tm.identifyAdmissibleOutputs(beef, prev)
    const txid = tx.id('hex')
    for (const i of prev) {
      const inp = tx.inputs[i]
      const op = `${inp.sourceTXID ?? inp.sourceTransaction!.id('hex')}.${inp.sourceOutputIndex}`
      this.admitted.delete(op); this.spent.add(op)
    }
    for (const o of r.outputsToAdmit) this.admitted.set(`${txid}.${o}`, beef)
    this.log.push(`${label}: prev=${JSON.stringify(prev)} -> ${JSON.stringify(r)}`)
    return r
  }
  patch(b: BTMS) {
    ;(b as any).broadcastWithRetry = async (tx: Transaction, ctx: string) => {
      const r = await this.submit(tx, `btms:${ctx}`)
      if (r.outputsToAdmit.length === 0 && r.coinsRemoved.length === 0) throw new Error('overlay admitted nothing')
    }
    ;(b as any).lookupTokenOnOverlay = async (txid: string, outputIndex: number, includeBeef = false) => {
      const beef = this.admitted.get(`${txid}.${outputIndex}`)
      if (beef == null) return { found: false }
      return { found: true, beef: includeBeef ? Beef.fromBinary(beef) : undefined }
    }
    return b
  }
}

test('BTMS swap-and-pay (offline)', async t => {
  const chain = await MockChain.create()
  const ov = new LocalOverlay()
  try {
    const maker = await chain.createWallet('maker', 20_000, 2)
    const agent = await chain.createWallet('agent', 50_000, 4)
    const merchant = await chain.createWallet('merchant', 5_000, 2)
    const makerBtms = ov.patch(new BTMS({ wallet: maker.wallet as any, networkPreset: 'local' }))

    // 1. Issue with the real BTMS library
    const iss = await makerBtms.issue(10, { name: 'pUSD' } as any)
    t.diagnostic(`issue: ${JSON.stringify(iss)}`)
    assert.ok(iss.success, iss.error)
    const assetId = iss.assetId
    const { tokens: issued } = await makerBtms.getSpendableTokens(assetId)
    assert.equal(issued.length, 1)
    const issuedTok = issued[0]
    const meta = issuedTok.token.metadata as string | undefined
    t.diagnostic(`issued token metadata=${meta} customInstructions=${issuedTok.customInstructions}`)

    // 2. Split into exact-size 1-unit tokens with our own createAction (maker console code path)
    const tpl = new BTMSToken(maker.wallet as any, P)
    const prefix = rand64()
    const pieces: Array<{ keyID: string; suffix: string }> = []
    const outputs: any[] = []
    for (let i = 0; i < 3; i++) {
      const suffix = rand64(); const keyID = `${prefix} ${suffix}`
      pieces.push({ keyID, suffix })
      outputs.push({ satoshis: 1, lockingScript: (await tpl.createTransfer(assetId, 1, keyID, 'self', meta)).toHex(), basket: 'p btms', customInstructions: JSON.stringify({ derivationPrefix: prefix, derivationSuffix: suffix }), tags: ['btms_type_change', `btms_assetid_${assetId}`], outputDescription: 'offer piece' })
    }
    const csuf = rand64()
    outputs.push({ satoshis: 1, lockingScript: (await tpl.createTransfer(assetId, 7, `${prefix} ${csuf}`, 'self', meta)).toHex(), basket: 'p btms', customInstructions: JSON.stringify({ derivationPrefix: prefix, derivationSuffix: csuf }), tags: ['btms_type_change', `btms_assetid_${assetId}`], outputDescription: 'pUSD change' })
    const issCI = JSON.parse(issuedTok.customInstructions!)
    const issueTxBeef = (await maker.wallet.listOutputs({ basket: 'p btms', include: 'entire transactions' })).BEEF!
    const splitC = await maker.wallet.createAction({
      description: 'Split pUSD', inputBEEF: issueTxBeef,
      inputs: [{ outpoint: issuedTok.outpoint, unlockingScriptLength: 74, inputDescription: 'issued pUSD' }],
      outputs, labels: ['p btms type split'], options: { randomizeOutputs: false }
    })
    const stx = Transaction.fromAtomicBEEF(splitC.signableTransaction!.tx)
    const un = await tpl.createUnlocker(`${issCI.derivationPrefix} ${issCI.derivationSuffix}`, 'self').sign(stx, 0)
    const splitDone = await maker.wallet.signAction({ reference: splitC.signableTransaction!.reference, spends: { 0: { unlockingScript: un.toHex() } } })
    const splitTx = Transaction.fromAtomicBEEF(splitDone.tx!)
    const rSplit = await ov.submit(splitTx, 'split')
    assert.deepEqual(rSplit.outputsToAdmit, [0, 1, 2, 3])
    t.diagnostic(`maker BTMS balance after split = ${await makerBtms.getBalance(assetId)}`)

    // 3. Maker presigns SINGLE|ANYONECANPAY offer with PushDrop.unlock('single', true) through the BRC-100 wallet
    async function makeOffer(vout: number) {
      const dp = rand64(), ds = rand64()
      const keys = maker.wallet.getClientChangeKeyPair()
      const payLock = new ScriptTemplateBRC29({ derivationPrefix: dp, derivationSuffix: ds, keyDeriver: maker.wallet.keyDeriver }).lock(keys.privateKey, keys.publicKey)
      const half = new Transaction(1, [], [], 0)
      half.addInput({ sourceTransaction: splitTx, sourceOutputIndex: vout, sequence: 0xffffffff, unlockingScript: new Script() })
      half.addOutput({ satoshis: N, lockingScript: payLock })
      const unlock = await new PushDrop(maker.wallet as any).unlock(P, pieces[vout].keyID, 'self', 'single', true).sign(half, 0)
      return { outpoint: `${splitTx.id('hex')}.${vout}`, unlockingScript: unlock.toHex(), payLock: payLock.toHex(), remittance: { derivationPrefix: dp, derivationSuffix: ds }, beef: splitDone.tx! }
    }
    const offer = await makeOffer(0)

    // 4. Merchant hands out a per-order BTMS receive key (self-derived); agent builds the PushDrop script with it
    const mPrefix = rand64(), mSuffix = rand64()
    const { publicKey: merchantKey } = await merchant.wallet.getPublicKey({ protocolID: P, keyID: `${mPrefix} ${mSuffix}`, counterparty: 'self' })
    const fakeKeyWallet = { getPublicKey: async () => ({ publicKey: merchantKey }) } as any
    const fields = [Utils.toArray(assetId, 'utf8'), Utils.toArray('1', 'utf8'), ...(meta ? [Utils.toArray(meta, 'utf8')] : [])]
    const merchantLock = await new PushDrop(fakeKeyWallet).lock(fields, P, 'x', 'self', false, false)

    // 5. Agent completes via guarded wallet (WalletPermissionsManager)
    const guarded = createGuardedWallet(agent.wallet)
    let seen: any
    guarded.bindCallback('onSpendingAuthorizationRequested', async (req: any) => { seen = req; await guarded.grantPermission({ requestID: req.requestID, ephemeral: true }) })
    const fill = await bindOriginator(guarded, 'agent.example.com').createAction({
      description: 'Swap sats to pUSD and pay API', inputBEEF: offer.beef,
      inputs: [{ outpoint: offer.outpoint, unlockingScript: offer.unlockingScript, inputDescription: 'maker pUSD offer' }],
      outputs: [
        { lockingScript: offer.payLock, satoshis: N, outputDescription: 'pay market maker' },
        { lockingScript: merchantLock.toHex(), satoshis: 1, outputDescription: 'pUSD to API merchant' }
      ],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    const fillTx = Transaction.fromAtomicBEEF(fill.tx!)
    t.diagnostic(`FILL txid=${fill.txid} outputs=${fillTx.outputs.map(o => o.satoshis).join(',')} fee=${fillTx.getFee()} guardianSats=${seen?.spending?.satoshis}`)
    assert.equal(fillTx.outputs[0].lockingScript.toHex(), offer.payLock)

    // 6. Overlay admission of the fill
    const rFill = await ov.submit(fillTx, 'fill')
    assert.deepEqual(rFill.outputsToAdmit, [1])

    // 7. Merchant internalizes WITHOUT BTMS messaging (basket insertion with BTMS-compatible customInstructions)
    const decoded = BTMSToken.decode(fillTx.outputs[1].lockingScript.toHex())
    assert.ok(decoded.valid)
    assert.equal(decoded.lockingPublicKey, merchantKey)
    const ir = await merchant.wallet.internalizeAction({
      tx: fill.tx!, description: 'Receive pUSD for order 1', labels: [`p btms assetId ${assetId}`],
      outputs: [{ outputIndex: 1, protocol: 'basket insertion', insertionRemittance: { basket: 'p btms', customInstructions: JSON.stringify({ derivationPrefix: mPrefix, derivationSuffix: mSuffix }), tags: ['btms_type_receive', `btms_assetid_${assetId}`] } }]
    })
    assert.ok(ir.accepted)
    // Maker internalizes its sats
    const mb = await maker.wallet.balance()
    await maker.wallet.internalizeAction({ tx: fill.tx!, description: 'offer filled', outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { ...offer.remittance, senderIdentityKey: maker.identityKey } }] })
    t.diagnostic(`maker sats ${mb} -> ${await maker.wallet.balance()}`)

    // 8. Merchant's stock BTMS library sees and can SPEND the token (send back to maker)
    const merchantBtms = ov.patch(new BTMS({ wallet: merchant.wallet as any, networkPreset: 'local' }))
    const bal = await merchantBtms.getBalance(assetId)
    t.diagnostic(`merchant BTMS balance=${bal}`)
    assert.equal(bal, 1)
    const sent = await merchantBtms.send(assetId, maker.identityKey, 1)
    t.diagnostic(`merchant btms.send -> ${JSON.stringify({ success: sent.success, txid: sent.txid, error: sent.error })}`)
    assert.ok(sent.success, sent.error)

    await t.test('NEG: second fill of same offer rejected', async () => {
      const a2 = await chain.createWallet('agent2', 20_000, 2)
      await assert.rejects(a2.wallet.createAction({ description: 'dup fill', inputBEEF: offer.beef, inputs: [{ outpoint: offer.outpoint, unlockingScript: offer.unlockingScript, inputDescription: 'maker pUSD offer' }], outputs: [{ lockingScript: offer.payLock, satoshis: N, outputDescription: 'pay market maker' }, { lockingScript: merchantLock.toHex(), satoshis: 1, outputDescription: 'pUSD to merchant' }], options: { randomizeOutputs: false } }), (e: any) => { t.diagnostic(`dup fill -> ${e.name}: ${String(e.message).slice(0, 160)}`); return true })
    })
    await t.test('NEG: taker underpays maker by 1 sat -> rejected', async () => {
      const off2 = await makeOffer(1)
      const a3 = await chain.createWallet('agent3', 20_000, 2)
      await assert.rejects(a3.wallet.createAction({ description: 'underpay', inputBEEF: off2.beef, inputs: [{ outpoint: off2.outpoint, unlockingScript: off2.unlockingScript, inputDescription: 'maker pUSD offer' }], outputs: [{ lockingScript: off2.payLock, satoshis: N - 1, outputDescription: 'pay market maker' }, { lockingScript: merchantLock.toHex(), satoshis: 1, outputDescription: 'pUSD to merchant' }], options: { randomizeOutputs: false } }), (e: any) => { t.diagnostic(`underpay -> ${e.name}: ${String(e.message).slice(0, 160)}`); return true })
    })
    await t.test('Overlay: amount inflation / metadata change in merchant output not admitted', async () => {
      const off3 = await makeOffer(2)
      const bad = await new PushDrop(fakeKeyWallet).lock([Utils.toArray(assetId, 'utf8'), Utils.toArray('2', 'utf8'), ...(meta ? [Utils.toArray(meta, 'utf8')] : [])], P, 'x', 'self', false, false)
      const a4 = await chain.createWallet('agent4', 20_000, 2)
      const f = await a4.wallet.createAction({ description: 'inflate', inputBEEF: off3.beef, inputs: [{ outpoint: off3.outpoint, unlockingScript: off3.unlockingScript, inputDescription: 'maker pUSD offer' }], outputs: [{ lockingScript: off3.payLock, satoshis: N, outputDescription: 'pay market maker' }, { lockingScript: bad.toHex(), satoshis: 1, outputDescription: 'pUSD to merchant' }], options: { randomizeOutputs: false } })
      const r = await ov.submit(Transaction.fromAtomicBEEF(f.tx!), 'inflated')
      t.diagnostic(`inflated fill MINED txid=${f.txid}; overlay=${JSON.stringify(r)}`)
      assert.deepEqual(r.outputsToAdmit, [])
    })
    t.diagnostic('OVERLAY LOG:\n' + ov.log.join('\n'))
  } finally {
    await (chain as any).destroy?.()
  }
})
