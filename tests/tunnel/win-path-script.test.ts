import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Run the shipped script, not a handcrafted copy of its output. macOS/Linux can use
// an explicit portable pwsh for this test; Windows uses its normal PowerShell.
const powershell = process.env.TOOLBOX_POWERSHELL_TEST_BIN ?? (process.platform === 'win32' ? 'powershell.exe' : '')
const script = fileURLToPath(new URL('../../sidecar/win/wininet-settings.ps1', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/windows-path-queries.ps1', import.meta.url))
const adapterUrl = new URL('../../sidecar/win/adapter-wininet.mjs', import.meta.url).href
const canonical = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function readPath(guid: string) {
  return spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture, '-TargetScript', script], {
    input: JSON.stringify({ operation: 'path' }), encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, TOOLBOX_TEST_INTERFACE_GUID: guid }
  })
}

describe.skipIf(powershell === '')('Windows path script with real PowerShell and read-only command fixtures', () => {
  it.each([canonical, canonical.toUpperCase(), `{${canonical.toUpperCase()}}`])('normalizes the valid adapter GUID %s before enforcing its identity', (guid) => {
    const result = readPath(guid)
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual({ metric: 15, interfaceIndex: 12, interfaceGuid: canonical, kind: 'network-interface' })
  })

  it.each(['', 'not-a-guid', `{${canonical}`, '00000000-0000-0000-0000-000000000000'])('rejects missing or invalid GUID %s without exposing its input', (guid) => {
    const result = readPath(guid)
    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toBe('')
    expect(result.stderr.trim()).toBe('WININET_ACCESS_FAILED')
  })

  it('passes a Windows braced GUID through the shipped script and actual JS adapter contract', () => {
    const source = `
      import { execFileSync } from 'node:child_process'
      import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
      import { tmpdir } from 'node:os'
      import { join } from 'node:path'
      process.env.TOOLBOX_REAL_NETWORK_ADAPTER = '1'
      const { createAdapter } = await import(${JSON.stringify(adapterUrl)})
      const { createDaemon } = await import(${JSON.stringify(new URL('../../sidecar/win/daemon-core.mjs', import.meta.url).href)})
      const { composeManagedAdapters } = await import(${JSON.stringify(new URL('../../sidecar/win/managed-adapter.mjs', import.meta.url).href)})
      const { createTerminalEnvironmentAdapter } = await import(${JSON.stringify(new URL('../../sidecar/win/terminal-environment.mjs', import.meta.url).href)})
      const { createAdapter: fakeAdapter } = await import(${JSON.stringify(new URL('./fixtures/fake-wininet-adapter.mjs', import.meta.url).href)})
      const adapter = createAdapter({ nativeNotify: undefined, sleep: () => undefined,
        execFile(command, args, options) {
          if (command !== 'powershell.exe' || JSON.parse(options.input).operation !== 'path') throw new Error('UNEXPECTED_COMMAND')
          return execFileSync(${JSON.stringify(powershell)}, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
            ${JSON.stringify(fixture)}, '-TargetScript', args.at(-1)], { ...options,
            env: { ...process.env, TOOLBOX_TEST_INTERFACE_GUID: ${JSON.stringify(`{${canonical.toUpperCase()}}`)} } })
        }
      })
      const dataDir = mkdtempSync(join(tmpdir(), 'win-path-chain-'))
      try {
        const store = join(dataDir, 'registry.json')
        const base = fakeAdapter({ FAKE_WININET_STORE: store })
        let writes = 0
        const network = { ...base, write: (...args) => { writes++; return base.write(...args) }, existingProxy: () => undefined,
          currentPathIdentity: adapter.currentPathIdentity }
        writeFileSync(join(dataDir, 'intent.json'), JSON.stringify({ desired: 'connected', sessionToken: 'path-fixture',
          bridgePort: 18080, reuseDirect: true, connector: { kind: 'loopback-probe', host: '127.0.0.1', port: 1, exitIp: '203.0.113.9' } }))
        let probes = 0, starts = 0
        const daemon = createDaemon({ dataDir, adapter: composeManagedAdapters(network, createTerminalEnvironmentAdapter({ enabled: false })),
          clock: { now: () => 1000000, setTimeout: () => 1, setInterval: () => 1, clearTimer() {} },
          parentAlive: () => true, onExit() {}, probeDirect: async () => { probes++; return { direct: true } },
          connectorFactory: () => { starts++; throw new Error('Unexpected connector start') },
          bridgeFactory: () => { throw new Error('Unexpected bridge start') }
        })
        await daemon.run()
        const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'))
        let identity = null
        try { identity = adapter.currentPathIdentity() } catch { /* Preserve the daemon's actual failure below. */ }
        console.log(JSON.stringify({ identity, state: state.state, code: state.code,
          probes, starts, writes, registry: existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {} }))
      } catch (error) { console.log(JSON.stringify({ code: error.code ?? error.message })) }
      finally { rmSync(dataDir, { recursive: true, force: true }) }
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 20_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual({ identity: { id: `if:12:guid:${canonical}`, kind: 'network-interface' },
      state: 'connected', code: 'TUNNEL_REUSED_EXISTING', probes: 1, starts: 0, writes: 0, registry: {} })
  }, 20_000)
})
