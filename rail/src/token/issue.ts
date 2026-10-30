// Issues pUSD with the BTMS token format but our own protocol switch, so issuance also works
// when BSV Desktop has no BTMS permission module (TOKEN_PROTOCOL set). The asset ID is the
// issuance outpoint, `<txid>.0`.
import { Transaction, type WalletInterface, type WalletProtocol } from '@bsv/sdk'
import { BTMSToken } from '@bsv/btms'
import type { OwnedToken } from './split'
import {
  btmsCustomInstructions,
  bytes,
  keyIdOf,
  randomDerivation,
  tokenBasket,
  tokenLabel,
  tokenProtocol
} from './pusd'

export interface Issued {
  tx: Transaction
  token: OwnedToken
}

export async function issueToken(
  wallet: WalletInterface,
  amount: number,
  metadata: Record<string, unknown>,
  options: { protocol?: WalletProtocol; originator?: string } = {}
): Promise<Issued> {
  const protocol = options.protocol ?? tokenProtocol()
  const prefix = randomDerivation()
  const suffix = randomDerivation()
  const keyID = keyIdOf(prefix, suffix)
  const lockingScript = await new BTMSToken(wallet, protocol, options.originator).createIssuance(amount, keyID, metadata, 'self')
  const created = await wallet.createAction(
    {
      description: 'Issue pUSD',
      outputs: [
        {
          satoshis: 1,
          lockingScript: lockingScript.toHex(),
          basket: tokenBasket(),
          customInstructions: btmsCustomInstructions(prefix, suffix),
          tags: ['btms_type_issue'],
          outputDescription: 'pUSD issuance'
        }
      ],
      labels: [tokenLabel('type issue')],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
    },
    options.originator
  )
  if (created.tx === undefined) throw new Error('Wallet did not return the issuance transaction')
  const atomicBeef = bytes(created.tx)
  const tx = Transaction.fromAtomicBEEF(atomicBeef)
  const assetId = `${tx.id('hex')}.0`
  return {
    tx,
    // Same serialisation as BTMSToken.buildFields; transfers must repeat it byte for byte.
    token: {
      outpoint: assetId,
      beef: atomicBeef,
      keyID,
      assetId,
      amount,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined
    }
  }
}
