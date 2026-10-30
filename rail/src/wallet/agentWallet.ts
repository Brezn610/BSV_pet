// The pet never touches its raw wallet. Every spend goes through a
// WalletPermissionsManager whose "user approval" prompt is answered by the
// Guardian agent instead of a human.
import type { WalletInterface } from '@bsv/sdk'
import { WalletPermissionsManager, type Wallet } from '@bsv/wallet-toolbox'
import type { TxObserver } from '../guardian/txObserver'

/** The admin originator is the pet's own runtime (soul token upkeep). It is never handed to the pet's brain. */
export const ADMIN_ORIGINATOR = 'admin.satspet.local'

/** With `observer`, the guardian can also see each transaction it is asked to authorize. */
export function createGuardedWallet(underlying: Wallet, observer?: TxObserver): WalletPermissionsManager {
  return new WalletPermissionsManager(observer === undefined ? underlying : observer.wrap(underlying), ADMIN_ORIGINATOR, {
    // The demo is about money. Every other permission class is switched off so
    // the only prompt that can fire is a spending authorization.
    seekSpendingPermissions: true,
    seekProtocolPermissionsForSigning: false,
    seekProtocolPermissionsForEncrypting: false,
    seekProtocolPermissionsForHMAC: false,
    seekPermissionsForKeyLinkageRevelation: false,
    seekPermissionsForPublicKeyRevelation: false,
    seekPermissionsForIdentityKeyRevelation: false,
    seekPermissionsForIdentityResolution: false,
    seekBasketInsertionPermissions: false,
    seekBasketRemovalPermissions: false,
    seekBasketListingPermissions: false,
    seekPermissionWhenApplyingActionLabels: false,
    seekPermissionWhenListingActionsByLabel: false,
    seekCertificateDisclosurePermissions: false,
    seekCertificateAcquisitionPermissions: false,
    seekCertificateRelinquishmentPermissions: false,
    seekCertificateListingPermissions: false,
    seekGroupedPermission: false,
    // Keep descriptions readable so the guardian and the dashboard can show them.
    encryptWalletMetadata: false
  })
}

/**
 * Returns a view of `wallet` that always calls with `originator`.
 *
 * @bsv/402-pay passes the URL origin ("http://localhost:4001") as originator,
 * but the permissions manager only accepts bare domain names. Binding a
 * merchant domain here also tells the guardian exactly who is asking for money.
 */
export function bindOriginator(wallet: WalletInterface, originator: string): WalletInterface {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (args: unknown) => value.call(target, args, originator)
    }
  })
}
