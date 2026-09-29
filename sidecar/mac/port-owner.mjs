// macOS 入口端口取证。只读 lsof/ps；绝不结束任何 PID。
import { execFileSync } from 'node:child_process'

function listenerPids(raw) {
  const pids = new Set()
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const match = /^p([1-9][0-9]*)$/.exec(line.trim())
    if (match !== null) pids.add(Number(match[1]))
  }
  return [...pids]
}

/** Only the bundled daemon script is product identity; names and ports are not proof. */
export function isLaixinDaemonCommand(command) {
  return /(?:^|\s)\S*[/\\](?:来信AI工具箱统一版|来信AI工具箱)\.app[/\\]Contents[/\\](?:Resources|resources)[/\\]sidecar[/\\]mac[/\\]tunnel-daemon\.mjs(?:\s|$)/.test(String(command ?? ''))
}

/**
 * Identify one TCP listener without guessing. A racing/no-listener lookup is
 * distinct from an unreadable or multiple-owner result. Process commands are
 * examined locally only and never put into daemon state or diagnostics.
 */
export function identifyPortOwner(port, { exec = execFileSync, timeoutMs = 4000 } = {}) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return { kind: 'unknown' }
  let pids
  try {
    pids = listenerPids(exec('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fpc'], {
      encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']
    }))
  } catch (error) {
    // lsof uses exit 1 for "no matching listener"; all other failures remain unknown.
    if (error?.status === 1 && String(error?.stdout ?? '').trim() === '') return { kind: 'none' }
    return { kind: 'unknown' }
  }
  if (pids.length === 0) return { kind: 'none' }
  if (pids.length !== 1) return { kind: 'unknown', reason: 'multiple-listeners' }
  const pid = pids[0]
  try {
    const command = exec('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']
    })
    return isLaixinDaemonCommand(command) ? { kind: 'laixin', pid } : { kind: 'other', pid }
  } catch { return { kind: 'unknown' } }
}
