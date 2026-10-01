import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// A separately compiled native test artifact. There is NO runtime environment
// switch from the production helper to fixture paths or an unprivileged server.
describe.skipIf(process.platform !== 'darwin')('原生特权助手：隔离系统边界，真实 IPC/日志/进程死亡恢复', () => {
  let root: string
  let binary: string
  let server: ChildProcess
  const original = { HTTPEnable: 0, HTTPProxy: 'before.example', HTTPPort: 8123, OtherSetting: 'retain' }
  const ref = { service: 'Wi-Fi', item: 'web-proxy' }
  const write = { op: 'write', ref, value: { enabled: true, host: '127.0.0.1', port: 18080 } }
  const fixture = (value: unknown) => execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', join(root, 'system', 'services.plist'), '--', '-'], { input: JSON.stringify({ 'Wi-Fi': value }) })
  const state = () => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(root, 'system', 'services.plist')], { encoding: 'utf8' }))['Wi-Fi'] as Record<string, unknown>
  const request = (value: unknown) => JSON.parse(execFileSync(binary, ['request'], { input: JSON.stringify(value), encoding: 'utf8', timeout: 12_000 })) as { ok: boolean; code?: string; reason?: string }
  const until = async (predicate: () => boolean) => {
    for (let n = 0; n < 50; n += 1) {
      if (predicate()) return
      await new Promise((done) => setTimeout(done, 100))
    }
    throw new Error('native helper did not settle')
  }
  const launch = async () => {
    server = spawn(binary, ['serve'], { stdio: 'ignore' })
    await until(() => existsSync(join(root, 'control.sock')) && request({ op: 'status' }).ok)
  }
  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    if (server.exitCode !== null || server.signalCode !== null) return
    const exited = new Promise<void>((done) => server.once('exit', () => done()))
    const fallback = setTimeout(() => server.kill('SIGKILL'), 2000)
    server.kill(signal)
    await exited
    clearTimeout(fallback)
  }
  beforeAll(async () => {
    root = mkdtempSync('/tmp/lx-proxy-fixture-')
    mkdirSync(join(root, 'system'), { mode: 0o700 })
    binary = join(root, 'helper')
    execFileSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-mmacosx-version-min=12.0', '-Wall', '-Wextra', '-Werror',
      `-DLAIXIN_PROXY_FIXTURE="${root}"`, '-framework', 'Foundation', '-framework', 'SystemConfiguration',
      resolve('native/mac-proxy-helper.m'), '-o', binary])
    fixture(original)
    await launch()
  })
  afterAll(async () => {
    if (server) await stop()
    if (root) rmSync(root, { recursive: true, force: true })
  })
  it('授权后的原生写入成功，恢复保留原字段，不依赖 networksetup 普通用户权限', () => {
    expect(request(write)).toMatchObject({ ok: true })
    expect(state()).toEqual({ ...original, HTTPEnable: 1, HTTPProxy: '127.0.0.1', HTTPPort: 18080 })
    expect(readFileSync(join(root, 'journal.plist')).length).toBeGreaterThan(0)
    expect(request({ op: 'restore', ref })).toMatchObject({ ok: true })
    expect(state()).toEqual(original)
  })
  it('拒绝外部服务器、低端口、未知项目和任意程序命令，拒绝时不写系统边界', () => {
    for (const command of [
      { ...write, value: { ...write.value, host: 'outside.example' } },
      { ...write, value: { ...write.value, port: 22 } },
      { ...write, ref: { ...ref, item: 'DNS' } },
      { op: 'exec', executable: '/bin/sh', args: ['-c', 'anything'] }
    ]) expect(request(command)).toMatchObject({ ok: false })
    expect(state()).toEqual(original)
  })
  it.skipIf(process.getuid?.() === 0)('写前日志不能持久化时不写代理', () => {
    chmodSync(root, 0o500)
    try {
      expect(request(write)).toMatchObject({ ok: false })
      expect(state()).toEqual(original)
    } finally { chmodSync(root, 0o700) }
  })
  it('恢复时第三方已经改过的代理不覆盖；其他字段一直保留', () => {
    expect(request(write).ok).toBe(true)
    const changed = { ...original, HTTPEnable: 1, HTTPProxy: 'other.example', HTTPPort: 9000 }
    fixture(changed)
    expect(request({ op: 'restore', ref }).ok).toBe(true)
    expect(state()).toEqual(changed)
    fixture(original)
  })
  it.each([
    ['secure-web-proxy', 'HTTPSEnable', 'HTTPSProxy', 'HTTPSPort'],
    ['socks-proxy', 'SOCKSEnable', 'SOCKSProxy', 'SOCKSPort']
  ])('%s 从未配置的字段在断开时恢复为缺省，不能留下死地址', (item, enabled, host, port) => {
    expect(request({ ...write, ref: { ...ref, item } }).ok).toBe(true)
    expect(state()).toEqual({ ...original, [enabled]: 1, [host]: '127.0.0.1', [port]: 18080 })
    expect(request({ op: 'restore', ref: { ...ref, item } }).ok).toBe(true)
    expect(state()).toEqual(original)
  })
  it('PAC 只能关闭且保留 URL，恢复时完整还回原开关与 URL', () => {
    const pac = { ...original, ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'https://before.example/pac' }
    fixture(pac)
    const pacRef = { ...ref, item: 'auto-proxy' }
    expect(request({ op: 'write', ref: pacRef, value: { enabled: false, url: 'https://untrusted.example' } }).ok).toBe(true)
    expect(state()).toEqual({ ...pac, ProxyAutoConfigEnable: 0 })
    expect(request({ op: 'restore', ref: pacRef }).ok).toBe(true)
    expect(state()).toEqual(pac)
    fixture(original)
  })
  it('写入进程被 SIGKILL 后，独立助手恢复原代理', async () => {
    const child = spawn(process.execPath, ['-e', `
      const cp=require('node:child_process');
      const reply=JSON.parse(cp.execFileSync(${JSON.stringify(binary)},['request'],{input:${JSON.stringify(JSON.stringify(write))},encoding:'utf8'}));
      if (!reply.ok) process.exit(42);
      process.stdout.write('ready'); setInterval(()=>{},1000);
    `], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await until(() => state().HTTPEnable === 1)
      const exited = new Promise<void>((done) => child.once('exit', () => done()))
      child.kill('SIGKILL'); await exited
      await until(() => state().HTTPEnable === 0)
      expect(state()).toEqual(original)
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  })
  it('助手被 SIGKILL 后重启，从持久日志恢复，不要求重新输入密码', async () => {
    expect(request(write).ok).toBe(true)
    await stop('SIGKILL')
    expect(state().HTTPEnable).toBe(1)
    await launch()
    expect(state()).toEqual(original)
  })
  it('单个写请求抛异常不会带走监听循环，下一次请求仍能写入', () => {
    writeFileSync(join(root, 'fault'), 'exception')
    try {
      expect(request(write)).toMatchObject({ ok: false, reason: 'REQUEST_EXCEPTION' })
      expect(request({ op: 'status' }).ok).toBe(true)
    } finally { unlinkSync(join(root, 'fault')) }
    expect(request(write).ok).toBe(true)
    expect(request({ op: 'restore', ref }).ok).toBe(true)
  })
  it('监听描述符失效必须退出，不能活着失聪；重启清理残留 socket', async () => {
    writeFileSync(join(root, 'fault'), 'listener')
    try {
      expect(request(write).ok).toBe(false)
      await until(() => server.exitCode !== null)
      expect(server.exitCode).toBe(74)
    } finally { unlinkSync(join(root, 'fault')) }
    writeFileSync(join(root, 'control.sock'), 'stale-socket')
    await launch()
    expect(request(write).ok).toBe(true)
    expect(request({ op: 'restore', ref }).ok).toBe(true)
  })
  it('提交后卡住有内部截止时间；退出保留日志，下一次启动还原已写代理', async () => {
    writeFileSync(join(root, 'fault'), 'commit-hang')
    const started = Date.now()
    try {
      expect(request(write)).toMatchObject({ ok: false, reason: 'TIMEOUT' })
      expect(Date.now() - started).toBeLessThan(9000)
      await until(() => server.exitCode !== null)
      expect(server.exitCode).toBe(75)
      expect(state().HTTPEnable).toBe(1)
      expect(request({ op: 'status' })).toMatchObject({ ok: false, reason: 'CONNECTION_REFUSED' })
    } finally { unlinkSync(join(root, 'fault')) }
    await launch()
    expect(state()).toEqual(original)
  }, 15_000)
  it('损坏的恢复日志不能被当成空记录覆盖', async () => {
    await stop()
    const journalPath = join(root, 'journal.plist')
    const previous = readFileSync(journalPath)
    writeFileSync(journalPath, 'corrupt-recovery-evidence')
    try {
      server = spawn(binary, ['serve'], { stdio: 'ignore' })
      const result = await new Promise<number | null>((done) => server.once('exit', (code) => done(code)))
      expect(result).toBe(74)
      expect(readFileSync(journalPath, 'utf8')).toBe('corrupt-recovery-evidence')
      expect(state()).toEqual(original)
    } finally {
      writeFileSync(journalPath, previous)
      await launch()
    }
  })
})
