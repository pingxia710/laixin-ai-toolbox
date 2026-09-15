// Windows 的 HKCU\Software\Microsoft\Command Processor 是可选键：新装系统整个键不存在，⛔ 当成注册表不可读而拦住连接；
// 权限拒绝、reg.exe 起不来才是真的读不了。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTerminalEnvironmentAdapter } from '../../sidecar/win/terminal-environment.mjs'
import { composeManagedAdapters } from '../../sidecar/win/managed-adapter.mjs'

const KEY = 'HKCU\\Software\\Microsoft\\Command Processor'
const PARENT = 'HKCU\\Software\\Microsoft'
const notFound = () => Object.assign(new Error('reg failed'), { status: 1, stderr: 'ERROR: The system was unable to find the specified registry key or value.\r\n' })
const denied = () => Object.assign(new Error('reg failed'), { status: 1, stderr: 'ERROR: Access is denied.\r\n' })

function makeRun(mode: string, calls: string[]) {
  return (command: string, args: readonly string[]) => {
    calls.push([command, ...args].join(' '))
    if (command !== 'reg.exe' || args[0] !== 'query') throw new Error('stub: unexpected command')
    const key = args[1]; const valueQuery = args.includes('/v')
    if (mode === 'value-absent') {
      if (valueQuery) throw notFound()
      return `\r\n${KEY}\r\n    CompletionChar    REG_DWORD    0x9\r\n`
    }
    if (mode === 'key-absent') {
      if (key === PARENT) return `\r\n${PARENT}\r\n${PARENT}\\Windows\r\n`
      throw notFound()
    }
    if (mode === 'access-denied') { if (key === PARENT) return `\r\n${PARENT}\r\n`; throw denied() }
    if (mode === 'registry-unreadable') throw Object.assign(new Error('spawn reg.exe ENOENT'), { code: 'ENOENT' })
    throw new Error('stub: unknown mode')
  }
}

function build(mode: string) {
  const calls: string[] = []
  const home = mkdtempSync(join(tmpdir(), 'laixin-win-autorun-'))
  const terminal = createTerminalEnvironmentAdapter({ enabled: true, home, documentsDirectory: join(home, 'Documents'), run: makeRun(mode, calls) })
  const fakeNetwork = { preflight() {}, managedItems: () => [], read: () => null, write() {} }
  return { calls, terminal, composed: composeManagedAdapters(fakeNetwork, terminal) }
}

describe('Windows Command Processor 可选键', () => {
  it('键在、AutoRun 值不在 → 空值，连接放行', () => {
    const f = build('value-absent')
    expect(f.terminal.read({ service: 'TerminalEnvironment', item: 'win-cmd-autorun' })).toMatchObject({ exists: false })
    expect(() => f.composed.preflight!({ host: '127.0.0.1', port: 18080 })).not.toThrow()
  })
  it('整个键不存在（新装 Windows）→ 父键可读即按空值处理，连接放行', () => {
    const f = build('key-absent')
    expect(f.terminal.read({ service: 'TerminalEnvironment', item: 'win-cmd-autorun' })).toMatchObject({ exists: false })
    expect(() => f.composed.preflight!({ host: '127.0.0.1', port: 18080 })).not.toThrow()
    expect(f.calls.some((call) => call.includes(PARENT) && !call.includes(KEY))).toBe(true)
  })
  it('权限拒绝 → 仍判注册表不可读，⛔ 当空值去覆盖;组合适配器把它当可选项跳过,⛔ 挡网络(发布审查 R2)', () => {
    const f = build('access-denied')
    expect(() => f.terminal.read({ service: 'TerminalEnvironment', item: 'win-cmd-autorun' })).toThrow(expect.objectContaining({ code: 'TERMINAL_ENVIRONMENT_REGISTRY_READ_FAILED' }))
    expect(() => f.composed.preflight!({ host: '127.0.0.1', port: 18080 })).not.toThrow()
    expect(f.composed.optionalNote?.()).toContain('终端自动接入这次没启用')
  })
  it('reg.exe 起不来 → 注册表不可读', () => {
    const f = build('registry-unreadable')
    expect(() => f.terminal.read({ service: 'TerminalEnvironment', item: 'win-cmd-autorun' })).toThrow(expect.objectContaining({ code: 'TERMINAL_ENVIRONMENT_REGISTRY_READ_FAILED' }))
  })
})
