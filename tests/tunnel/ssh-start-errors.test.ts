import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createSshSocksConnector as macConnector } from '../../sidecar/mac/connectors.mjs'
import { createSshSocksConnector as winConnector } from '../../sidecar/win/connectors.mjs'

describe.each([['macOS', macConnector], ['Windows', winConnector]] as const)('%s SSH 启动错误', (_platform, createConnector) => {
  it.each([
    ['Host key verification failed.', '节点身份不符'],
    ['Permission denied (publickey).', '授权失效'],
    ['bind [127.0.0.1]:18080: Address already in use', '端口占用'],
    ['Connection refused', '上游不可达']
  ])('保留 %s 的分类，不被端口等待覆盖', async (stderr, code) => {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null as number | null, kill: vi.fn() })
    const spec = {
      kind: 'ssh-socks' as const, node: { host: 'unused.invalid', port: 22, sshUser: 'fixture' },
      keyPath: '/unused-key', knownHostsPath: '/unused-hosts', localPort: 0,
      verifyUrl: 'http://unused.invalid', readyTimeoutMs: 1_000, sshExecutable: process.execPath
    }
    const connector = createConnector(spec, { spawn: () => {
      queueMicrotask(() => {
        child.stderr.write(stderr)
        child.exitCode = 255
        child.emit('exit', 255)
      })
      return child
    } })
    const lost = vi.fn()
    connector.onLost(lost)
    try {
      await expect(connector.start()).rejects.toMatchObject({ code })
      expect(lost).toHaveBeenCalledWith(expect.objectContaining({ code }))
    } finally { await connector.stop(); child.stderr.destroy() }
  })

  it.each([
    ['ENOENT'],
    ['EACCES']
  ])('spawn 失败(%s)归类为「组件缺失」，⛔ 冒成未捕获异常把守护打崩', async (errno) => {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), exitCode: null as number | null, kill: vi.fn() })
    const spec = {
      kind: 'ssh-socks' as const, node: { host: 'unused.invalid', port: 22, sshUser: 'fixture' },
      keyPath: '/unused-key', knownHostsPath: '/unused-hosts', localPort: 0,
      verifyUrl: 'http://unused.invalid', readyTimeoutMs: 1_000, sshExecutable: process.execPath
    }
    const connector = createConnector(spec, { spawn: () => {
      // spawn 本身失败只发 'error',不发 'exit';没有 error 监听它就是未捕获异常。
      queueMicrotask(() => { child.emit('error', Object.assign(new Error(`spawn ssh ${errno}`), { code: errno })) })
      return child
    } })
    const lost = vi.fn()
    connector.onLost(lost)
    try {
      await expect(connector.start()).rejects.toMatchObject({ code: '组件缺失' })
      expect(lost).toHaveBeenCalledWith(expect.objectContaining({ code: '组件缺失' }))
    } finally { await connector.stop(); child.stderr.destroy() }
  })
})

describe('受控码表完整性', () => {
  it('mac 与 win 的 componentMissing 逐字相同：daemon-core 的致命码表直接引用它', async () => {
    const mac = await import('../../sidecar/mac/connectors.mjs')
    const win = await import('../../sidecar/win/connectors.mjs')
    // ⛔ undefined:致命码表里塞 undefined 等于这一类永远判不出来。
    expect(mac.CONTROL_CODES.componentMissing).toBe('组件缺失')
    expect(mac.CONTROL_CODES.componentMissing).toBe(win.CONTROL_CODES.componentMissing)
  })
})
