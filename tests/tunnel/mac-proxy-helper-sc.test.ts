import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Real SCPreferences lock/read/commit/apply, with an absolute temporary prefsID.
// It never opens the machine's default network configuration.
describe.skipIf(process.platform !== 'darwin')('原生助手真实 SCPreferences 隔离文件', () => {
  let root: string
  let binary: string
  let server: ChildProcess
  const original = { HTTPEnable: 0, HTTPProxy: 'before.example', HTTPPort: 8123 }
  const ref = { service: 'Wi-Fi', item: 'web-proxy' }
  const request = (value: unknown) => JSON.parse(execFileSync(binary, ['request'], {
    input: JSON.stringify(value), encoding: 'utf8', timeout: 10_000
  })) as { ok: boolean; code?: string; reason?: string; systemCode?: number }
  const state = () => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(root, 'system/services.plist')], { encoding: 'utf8' })).NetworkServices.fixture.Proxies
  beforeAll(async () => {
    root = mkdtempSync('/tmp/lx-proxy-sc-')
    mkdirSync(join(root, 'system'), { mode: 0o700 })
    binary = join(root, 'helper')
    execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-O2', '-mmacosx-version-min=12.0', '-Wall', '-Wextra', '-Werror',
      `-DLAIXIN_PROXY_FIXTURE="${root}"`, '-DLAIXIN_PROXY_REAL_SC_FIXTURE=1',
      '-framework', 'Foundation', '-framework', 'SystemConfiguration', resolve('native/mac-proxy-helper.m'), '-o', binary])
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', join(root, 'system/services.plist'), '--', '-'], { input: JSON.stringify({
      NetworkServices: { fixture: { UserDefinedName: 'Wi-Fi', Interface: { DeviceName: 'en0', Type: 'Ethernet', Hardware: 'Ethernet' }, Proxies: original } }
    }) })
    server = spawn(binary, ['serve'], { stdio: ['ignore', 'ignore', 'pipe'] })
    server.stderr?.on('data', (data) => process.stderr.write(data))
    for (let n = 0; n < 50; n += 1) {
      if (existsSync(join(root, 'control.sock')) && request({ op: 'status' }).ok) return
      if (server.exitCode !== null) throw new Error(`helper exited ${server.exitCode}`)
      await new Promise((done) => setTimeout(done, 100))
    }
    throw new Error('SC helper not ready')
  })
  afterAll(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = new Promise<void>((done) => server.once('exit', () => done()))
      server.kill('SIGTERM'); await exited
    }
    if (root) rmSync(root, { recursive: true, force: true })
  })
  it('真实 SC 权限拒绝后仍监听；不把非 root 的隔离文件当成已授权写入', () => {
    expect(readFileSync(binary).includes(Buffer.from('Proxies'))).toBe(true)
    const symbols = execFileSync('/usr/bin/nm', ['-m', binary], { encoding: 'utf8' })
    expect(symbols).not.toContain('_kSCNetworkProtocolTypeProxies')
    expect(symbols).toContain('_SCNetworkSetCopyCurrent')
    expect(symbols).toContain('_SCNetworkSetCopyServices')
    expect(symbols).toMatch(/external _SCNetworkServiceCopy \(from SystemConfiguration\)/)
    expect(symbols).not.toContain('_SCNetworkServiceCopyAll')
    for (let n = 0; n < 3; n += 1) {
      const reply = request({ op: 'write', ref, value: { enabled: true, host: '127.0.0.1', port: 18080 } })
      expect(reply).toMatchObject(process.getuid?.() === 0 ? { ok: true } : { ok: false, reason: 'PREFERENCES_LOCK_FAILED', systemCode: 1003 })
      expect(state()).toEqual(process.getuid?.() === 0 ? { HTTPEnable: 1, HTTPProxy: '127.0.0.1', HTTPPort: 18080 } : original)
      expect(request({ op: 'status' })).toMatchObject({ ok: true })
      if (process.getuid?.() === 0) expect(request({ op: 'restore', ref })).toMatchObject({ ok: true })
      expect(state()).toEqual(original)
    }
  })
})
