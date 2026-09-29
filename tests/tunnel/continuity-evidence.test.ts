import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDaemon } from '../../sidecar/win/daemon-core.mjs'
import { formatDaemonLogLine, probeProxyFaces, summarizeProxyFaces } from '../../sidecar/win/continuity-evidence.mjs'
import { FakeClock, flushMicrotasks, makeTempDir, removeTempDir } from './helpers'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))
const temp = () => { const root = makeTempDir('laixin-continuity-'); roots.push(root); return root }
const entry = (service: string, item: string, originalValue: unknown, writtenValue: unknown) =>
  ({ kind: 'setting', service, item, originalValue, writtenValue, status: 'applied' })

describe('网络连续性留证', () => {
  it('逐项核实际四层代理，只输出比较计数，不带原值', () => {
    const secret = 'account-token-and-proxy-secret'
    const entries = [
      entry('WinINET', 'ProxyServer', null, secret),
      entry('TerminalEnvironment', 'win-user-env-HTTP_PROXY', null, secret),
      entry('TerminalEnvironment', 'win-cmd-autorun', null, secret),
      entry('TerminalEnvironment', 'win-git-bashrc', null, secret),
      entry('TerminalEnvironment', 'win-user-env-HTTPS_PROXY', null, secret),
      entry('WinINET', 'ProxyServer', null, secret)
    ]
    const current: Record<string, unknown> = {
      'WinINET/ProxyServer': secret,
      'TerminalEnvironment/win-user-env-HTTP_PROXY': null,
      'TerminalEnvironment/win-cmd-autorun': 'third-party',
      'TerminalEnvironment/win-git-bashrc': secret
    }
    const faces = summarizeProxyFaces(entries, { read: (ref) => {
      if (ref.item === 'win-user-env-HTTPS_PROXY') throw new Error(secret)
      return current[`${ref.service}/${ref.item}`]
    } })
    expect(faces.wininet.written).toBe(1)
    expect(faces.environment.original).toBe(1)
    expect(faces.environment.unreadable).toBe(1)
    expect(faces.cmd.changed).toBe(1)
    expect(faces.bash.written).toBe(1)
    expect(JSON.stringify(faces)).not.toContain(secret)
  })

  it('采样子进程仅读账本，读数失败不隔离或改写原证据', async () => {
    const root = temp()
    const ledger = join(root, 'ledger.json')
    const adapter = join(root, 'adapter.mjs')
    const source = JSON.stringify([entry('WinINET', 'ProxyServer', null, 'hidden-proxy-value')])
    writeFileSync(ledger, source)
    writeFileSync(adapter, 'export function createAdapter() { return { read: () => "hidden-proxy-value" } }\n')
    const faces = await probeProxyFaces(root, adapter)
    expect(faces?.wininet.written).toBe(1)
    expect(JSON.stringify(faces)).not.toContain('hidden-proxy-value')
    writeFileSync(ledger, '{broken')
    expect(await probeProxyFaces(root, adapter)).toBeUndefined()
    expect(readFileSync(ledger, 'utf8')).toBe('{broken')
  })

  it('慢采样与异常不阻塞状态写入，状态变化和守护代次仍可追溯', async () => {
    const root = temp()
    const clock = new FakeClock()
    const lines: string[] = []
    let finish: ((faces: Record<string, Record<string, number>>) => void) | undefined
    const pending = new Promise<Record<string, Record<string, number>>>((resolve) => { finish = resolve })
    const daemon = createDaemon({
      dataDir: root, runId: 'generation-a', clock,
      adapter: { read: () => null, write: () => {}, managedItems: () => [] },
      connectorFactory: () => { throw new Error('unused') },
      bridgeFactory: () => { throw new Error('unused') },
      parentAlive: () => true, onExit: () => {},
      log: (line) => lines.push(line), continuityEvidence: true,
      readContinuityFaces: () => pending
    }) as unknown as { writeStateNow(state: string): boolean }
    expect(daemon.writeStateNow('connected')).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')).state).toBe('connected')
    expect(lines.some((line) => line.includes('"phase":"transition"'))).toBe(true)
    await flushMicrotasks()
    finish?.({ wininet: { written: 1, original: 0, changed: 0, unreadable: 0 } })
    await flushMicrotasks()
    expect(lines.some((line) => line.includes('"phase":"sample"'))).toBe(true)
    const first = formatDaemonLogLine('state', { now: 1_000, pid: 1, runId: 'generation-a' })
    const next = formatDaemonLogLine('state', { now: 2_000, pid: 2, runId: 'generation-b' })
    expect(first).toContain('1970-01-01T00:00:01.000Z pid=1 run=generation-a')
    expect(next).toContain('1970-01-01T00:00:02.000Z pid=2 run=generation-b')
    expect(formatDaemonLogLine('state', { now: 2_000, pid: 2, runId: 'bad\nsecret' })).toContain('run=-')
  })
})
