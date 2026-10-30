// A mainnet server wallet (the agent's, the merchant's), built as the BSV guide §14.2 does:
// SQLite storage, Arcade first among broadcasters. The root key comes from the environment
// and never leaves this process. Monitor tasks are not started: our actions broadcast at once.
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { CachedKeyDeriver, PrivateKey } from '@bsv/sdk'
import { Monitor, Services, Setup, StorageKnex, Wallet, WalletStorageManager, randomBytesHex } from '@bsv/wallet-toolbox'

export const ARCADE_URL = 'https://arcade-v2-us-1.bsvblockchain.tech'

export interface ServerWallet {
  name: string
  wallet: Wallet
  identityKey: string
  services: Services
  close: () => Promise<void>
}

export async function openServerWallet(name: string, rootKeyHex: string, dataDir: string): Promise<ServerWallet> {
  const chain = 'main'
  const rootKey = PrivateKey.fromHex(rootKeyHex)
  const identityKey = rootKey.toPublicKey().toString()

  const options = Services.createDefaultOptions(chain)
  options.arcadeUrl = ARCADE_URL
  const services = new Services(options)

  mkdirSync(dataDir, { recursive: true })
  const knex = Setup.createSQLiteKnex(path.join(dataDir, `${name}-wallet.sqlite`))
  const storage = new StorageKnex({ ...StorageKnex.createStorageBaseOptions(chain), knex })
  // As Setup.createStorageKnex does it; the storage identity is only written on the first run.
  await storage.migrate(`${name}-wallet`, randomBytesHex(33))
  await storage.makeAvailable()
  const manager = new WalletStorageManager(identityKey, storage)
  await manager.makeAvailable()
  manager.setServices(services)

  const monitor = new Monitor(Monitor.createDefaultWalletMonitorOptions(chain, manager, services))
  const wallet = new Wallet({ chain, keyDeriver: new CachedKeyDeriver(rootKey), storage: manager, services, monitor })
  return {
    name,
    wallet,
    identityKey,
    services,
    // Also closes the SQLite connection.
    close: async () => {
      await wallet.destroy()
    }
  }
}
