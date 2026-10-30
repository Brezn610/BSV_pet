// Loads rail/.env (gitignored) into process.env, so root keys stay out of code and shell history.
import path from 'node:path'
import { existsSync } from 'node:fs'

export const RAIL_DIR = path.join(__dirname, '..')
export const DATA_DIR = path.join(RAIL_DIR, 'data')
export const ENV_FILE = path.join(RAIL_DIR, '.env')

export function loadEnv(): void {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE)
}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set. Run npm run keys:init first.`)
  return value
}
