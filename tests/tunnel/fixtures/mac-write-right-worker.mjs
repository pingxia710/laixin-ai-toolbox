import { appendSettingEntry } from '../../../sidecar/mac/ledger.mjs'
import { composeManagedAdapters } from '../../../sidecar/mac/managed-adapter.mjs'
import { acquireWriteRight } from '../../../sidecar/mac/macos-write-right.mjs'
import { restoreLedger } from '../../../sidecar/mac/restore.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [, , lockPath, dataDir, storePath, bridgePortText, faultMode] = process.argv
const bridgePort = Number(bridgePortText)
const ref = { service: 'FakeSystem', item: 'secure-web-proxy' }

function readSystem() {
  return JSON.parse(readFileSync(storePath, 'utf8'))
}

function writeSystem(value) {
  writeFileSync(storePath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

mkdirSync(dataDir, { recursive: true })
if (faultMode === 'wait-for-start') {
  writeFileSync(`${dataDir}.ready`, `${String(process.pid)}\n`, { mode: 0o600 })
  const gate = join(dirname(lockPath), 'start-three-way')
  while (!existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
}
const network = {
  preflight() {},
  managedItems: (proxy) => [{ ref, value: { enabled: true, host: proxy.host, port: proxy.port } }],
  read: () => readSystem(),
  write: (_ref, value) => writeSystem(value),
  valuesEqual: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  preserveExternalChanges: () => true,
  reapplyOnChange: () => true
}
const terminal = {
  preflight() {},
  managedItems: () => [],
  read: () => undefined,
  write() {},
  valuesEqual: () => true,
  restoredValueMatches: () => true
}
const rawAcquire = (options) => acquireWriteRight({
  ...options,
  lockPath,
  dataDir,
  ...(faultMode === 'crash-after-stale-removed'
    ? { afterStaleRemoved: () => process.kill(process.pid, 'SIGKILL') }
    : {}),
  ...(faultMode === 'crash-after-recovery-completed'
    ? { afterRecoveryCompletedPersisted: () => process.kill(process.pid, 'SIGKILL') }
    : {}),
  ...(faultMode === 'crash-after-recovery-removed'
    ? { afterRecoveryResponsibilityRemoved: () => process.kill(process.pid, 'SIGKILL') }
    : {})
})
const adapter = composeManagedAdapters(network, terminal, rawAcquire)
const right = adapter.acquireWriteRight({ timeoutMs: 0 })

if (right.acquired !== true) {
  process.stdout.write(`${JSON.stringify({ state: 'error', code: right.reason })}\n`)
  process.exit(0)
}

const originalValue = adapter.read(ref)
const writtenValue = { enabled: true, host: '127.0.0.1', port: bridgePort }
appendSettingEntry(dataDir, {
  ...ref,
  originalValue,
  writtenValue,
  sessionToken: `worker-${String(process.pid)}`,
  time: Date.now()
})
adapter.write(ref, writtenValue)
process.stdout.write(`${JSON.stringify({
  state: 'connected',
  port: bridgePort,
  abandonedRecovered: right.abandonedRecovered === true
})}\n`)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (!String(chunk).split(/\r?\n/).includes('stop')) return
  const restored = restoreLedger(dataDir, adapter)
  right.release()
  process.stdout.write(`${JSON.stringify({ state: 'stopped', restored: restored.restored.length })}\n`)
  process.exit(restored.failed.length === 0 ? 0 : 65)
})
