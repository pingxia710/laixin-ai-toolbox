import { deepEqual } from './restore.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const FACES = ['wininet', 'environment', 'cmd', 'bash', 'other']

function faceOf(entry) {
  if (entry.service === 'WinINET') return 'wininet'
  if (entry.service !== 'TerminalEnvironment') return 'other'
  if (entry.item.startsWith('win-user-env-')) return 'environment'
  if (entry.item.startsWith('win-cmd-')) return 'cmd'
  if (entry.item.startsWith('win-git-bash')) return 'bash'
  return 'other'
}

/** Only comparison counts leave this function. Proxy values, paths and account data stay local. */
export function summarizeProxyFaces(entries, adapter) {
  const faces = Object.fromEntries(FACES.map((face) => [face, { written: 0, original: 0, changed: 0, unreadable: 0 }]))
  const latest = new Map()
  for (const entry of entries) {
    if (entry?.kind === 'setting' && typeof entry.service === 'string' && typeof entry.item === 'string') {
      latest.set(`${entry.service}\0${entry.item}`, entry)
    }
  }
  const equal = adapter.valuesEqual ?? deepEqual
  for (const entry of latest.values()) {
    const counts = faces[faceOf(entry)]
    try {
      const current = adapter.read({ service: entry.service, item: entry.item })
      if (equal(current, entry.writtenValue, entry)) counts.written++
      else if (equal(current, entry.originalValue, entry)) counts.original++
      else counts.changed++
    } catch { counts.unreadable++ }
  }
  return faces
}

export function formatDaemonLogLine(line, { now, pid, runId }) {
  const safeRunId = typeof runId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(runId) ? runId : '-'
  return `[tunnel-daemon] ${new Date(now).toISOString()} pid=${String(pid)} run=${safeRunId} ${line}\n`
}

// Windows may need several bounded registry/terminal reads in one snapshot.
const PROBE_TIMEOUT_MS = 30_000
const PROBE_MAX_BYTES = 4_096

/** The OS reads happen in a disposable process, never on the network daemon's event loop. */
export function probeProxyFaces(dataDir, adapterPath) {
  return new Promise((resolve) => {
    const script = join(fileURLToPath(new URL('.', import.meta.url)), 'continuity-probe.mjs')
    let child
    try {
      child = spawn(process.execPath, [script, dataDir, adapterPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch { resolve(undefined); return }
    let output = ''
    let oversized = false
    child.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > PROBE_MAX_BYTES) { oversized = true; child.kill(); return }
      output += chunk
    })
    const timeout = setTimeout(() => {
      try { child.kill() } catch { /* Already exited. */ }
      resolve(undefined)
    }, PROBE_TIMEOUT_MS)
    child.once('error', () => { clearTimeout(timeout); resolve(undefined) })
    child.once('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0 || oversized) { resolve(undefined); return }
      try { resolve(safeFaceCounts(JSON.parse(output))) } catch { resolve(undefined) }
    })
  })
}

function safeFaceCounts(value) {
  const result = {}
  for (const face of FACES) {
    const source = value?.[face]
    if (!source || typeof source !== 'object') return undefined
    result[face] = {}
    for (const count of ['written', 'original', 'changed', 'unreadable']) {
      const number = source[count]
      if (!Number.isSafeInteger(number) || number < 0 || number > 10_000) return undefined
      result[face][count] = number
    }
  }
  return result
}
