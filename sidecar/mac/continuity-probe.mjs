import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { summarizeProxyFaces } from './continuity-evidence.mjs'

const [dataDir, adapterPath] = process.argv.slice(2)
if (!dataDir || !adapterPath) process.exit(64)

try {
  // Do not call loadLedger here: its corruption recovery writes to disk.
  const entries = JSON.parse(readFileSync(join(dataDir, 'ledger.json'), 'utf8'))
  if (!Array.isArray(entries)) throw new Error('LEDGER_INVALID')
  const adapterModule = await import(pathToFileURL(adapterPath).href)
  const adapter = await adapterModule.createAdapter(process.env)
  process.stdout.write(`${JSON.stringify(summarizeProxyFaces(entries, adapter))}\n`)
} catch {
  process.exitCode = 1
}
