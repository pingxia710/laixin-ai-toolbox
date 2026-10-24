import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const adapterUrl = new URL('../../sidecar/win/adapter-wininet.mjs', import.meta.url).href
const off = { type: 'REG_BINARY', data: '460000000000000001000000' }
const on = { type: 'REG_BINARY', data: '460000000000000009000000' }

function probe(settings: unknown, manual = false, fail = false, pac = false) {
  const script = `
    process.env.TOOLBOX_REAL_NETWORK_ADAPTER = '1'
    const { createAdapter } = await import(${JSON.stringify(adapterUrl)})
    const store = { DefaultConnectionSettings: ${JSON.stringify(settings)},
      ProxyEnable: { type: 'REG_DWORD', data: '${manual ? '1' : '0'}' },
      ProxyServer: { type: 'REG_SZ', data: '127.0.0.1:7890' },
      AutoConfigURL: ${pac ? JSON.stringify({ type: 'REG_SZ', data: 'https://pac.invalid/proxy.pac' }) : 'null'} }
    const reads = []
    const adapter = createAdapter({ sleep: () => {}, nativeNotify: () => {}, execFile: (command, args, options) => {
      if (command === 'reg.exe') throw new Error('mock fallback')
      const request = JSON.parse(options.input)
      if (request.operation !== 'read') throw new Error('UNEXPECTED_WRITE')
      reads.push(request.item)
      if (${fail} && request.item === 'DefaultConnectionSettings') throw new Error('mock unreadable')
      return JSON.stringify(store[request.item] ?? null)
    } })
    let result, failed = false
    try { result = adapter.existingProxy({ host: '127.0.0.1', port: 18080 }) } catch { failed = true }
    console.log(JSON.stringify({ result: result ?? null, failed, reads }))
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 })
  if (child.status !== 0) throw new Error(child.stderr)
  return JSON.parse(child.stdout) as { result: { kind: string; source: string } | null; failed: boolean; reads: string[] }
}

describe('WinINET 复用必须先查自动检测', () => {
  it.each([false, true])('WPAD 开启时不复用直连或手工代理 manual=%s', manual => {
    expect(probe(on, manual).result).toMatchObject({ kind: 'pac', source: 'WinINET/DefaultConnectionSettings' })
  })
  it.each([null, { type: 'REG_BINARY', data: '4600' }, { type: 'REG_SZ', data: off.data }])('未知自动检测状态不能当作已关闭 %j', value => {
    expect(probe(value).result?.kind).toBe('pac')
  })
  it('读取失败不能冒充无代理', () => { expect(probe(off, false, true).failed).toBe(true) })
  it('确认关闭后保留原直连和手工代理识别', () => {
    expect(probe(off)).toMatchObject({ result: null, failed: false })
    expect(probe(off, true).result?.kind).toBe('http')
  })
  it('显式 PAC 优先，识别过程不写设置', () => {
    expect(probe(on, true, false, true).result).toMatchObject({ kind: 'pac', source: 'WinINET/AutoConfigURL' })
  })
})
