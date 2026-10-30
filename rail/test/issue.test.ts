// Our own issuance, and the fallback for a BSV Desktop without the BTMS permission module:
// with TOKEN_PROTOCOL set, protocol, basket and labels all move off "p btms" and the
// registry still admits every step.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { MockChain, type MockWallet } from '../src/chain/mockChain'
import { LocalRegistry } from '../src/registry/localRegistry'
import { checkOffer, createOffer } from '../src/swap/offer'
import { issueToken } from '../src/token/issue'
import { tokenBasket, tokenProtocol } from '../src/token/pusd'
import { splitToken } from '../src/token/split'

let chain: MockChain
let maker: MockWallet

before(async () => {
  chain = await MockChain.create()
  maker = await chain.createWallet('maker', 20_000, 2)
})

after(async () => {
  delete process.env.TOKEN_PROTOCOL
  await chain.destroy()
})

for (const custom of [undefined, 'agent swap token']) {
  test(`issue, split and offer with ${custom === undefined ? 'the BTMS protocol' : 'our own protocol'}`, async () => {
    if (custom === undefined) delete process.env.TOKEN_PROTOCOL
    else process.env.TOKEN_PROTOCOL = custom
    assert.equal(tokenBasket(), custom ?? 'p btms')
    const registry = new LocalRegistry()

    const issued = await issueToken(maker.wallet, 10, { name: 'pUSD', unit: '0.01 USD' })
    assert.deepEqual((await registry.submit(issued.tx)).outputsToAdmit, [0])

    const split = await splitToken(maker.wallet, issued.token, [1, 1])
    assert.deepEqual((await registry.submit(split.tx)).outputsToAdmit, [0, 1, 2])

    const offer = await createOffer(maker.wallet, split.pieces[0], 1000)
    assert.deepEqual(checkOffer(offer), { ok: true })
    const { outputs } = await maker.wallet.listOutputs({ basket: tokenBasket() })
    assert.ok(outputs.length >= 3, `tokens kept in basket ${tokenBasket()} for ${JSON.stringify(tokenProtocol())}`)
  })
}
