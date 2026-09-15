import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { buildXrayConfig, createLocalBridge } from '../../sidecar/mac/local-bridge.mjs'
import { buildXrayConfig as buildWindowsXrayConfig } from '../../sidecar/win/local-bridge.mjs'
import { socks5Connect } from '../../sidecar/mac/socks5.mjs'
import { httpGetViaProxy, makeTempDir, removeTempDir, startFakeHttpMarker, startFakeSocks5Server, type FakeHttpMarker, type FakeSocks5 } from './helpers'

describe('官方 Xray 实际回环转发（不使用系统代理或外网）', () => {
  let dataDir: string
  let target: FakeHttpMarker
  let upstream: FakeSocks5
  let bridge: ReturnType<typeof createLocalBridge> | undefined
  beforeEach(async () => {
    dataDir = makeTempDir('toolbox-xray-')
    target = await startFakeHttpMarker('XRAY-TARGET-OK')
    upstream = await startFakeSocks5Server({ 'foreign.test:80': ['127.0.0.1', target.port] })
  })
  afterEach(async () => {
    await bridge?.close()
    await upstream.close()
    await target.close()
    removeTempDir(dataDir)
  })
  async function start() {
    bridge = createLocalBridge({
      listenPort: 0, dataDir, upstream: { host: '127.0.0.1', port: upstream.port },
      routes: { protectedDirectSuffixes: ['deepseek.com'], directSuffixes: ['cn'], tunnelSuffixes: ['localhost'] }
    })
    await bridge.listen()
    return bridge
  }

  it('真实 HTTP 与 SOCKS 同端口：局域网直连，未知域名原样传给 SSH SOCKS', async () => {
    const live = await start()
    expect(await httpGetViaProxy(live.port(), `http://127.0.0.1:${target.port}/`)).toContain('XRAY-TARGET-OK')
    expect(upstream.hits()).toHaveLength(0)
    expect(await httpGetViaProxy(live.port(), 'http://foreign.test/secret?token=private')).toContain('XRAY-TARGET-OK')
    const socket = await socks5Connect({ host: '127.0.0.1', port: live.port(), targetHost: 'foreign.test', targetPort: 80 })
    const response = new Promise<string>((resolve, reject) => {
      let text = ''
      socket.on('data', (chunk: Buffer) => { text += chunk.toString() })
      socket.on('end', () => resolve(text))
      socket.on('error', reject)
      socket.setTimeout(2_000, () => socket.destroy(new Error('SOCKS response timeout')))
    })
    socket.write('GET / HTTP/1.1\r\nHost: foreign.test\r\nConnection: close\r\n\r\n')
    expect(await response).toContain('XRAY-TARGET-OK')
    expect(upstream.hits()).toEqual([{ host: 'foreign.test', port: 80 }, { host: 'foreign.test', port: 80 }])
    expect(target.requestCount()).toBe(3)
    expect(existsSync(join(dataDir, 'bridge-access.log'))).toBe(false)
    expect(readFileSync(join(dataDir, 'xray-bridge.json'), 'utf8')).not.toContain('token=private')
  })

  it('上游断开不会回退直连；停止后原端口不能再接入', async () => {
    const live = await start()
    await upstream.close()
    // localhost 有确实可达的直连目标；若错误回退，目标会收到请求并返回标记。
    const body = await httpGetViaProxy(live.port(), `http://localhost:${target.port}/`)
    expect(body).not.toContain('XRAY-TARGET-OK')
    expect(target.requestCount()).toBe(0)
    const port = live.port()
    await live.close()
    expect(live.isAlive()).toBe(false)
    await expect(httpGetViaProxy(port, 'http://foreign.test/')).rejects.toThrow()
  })

  it('只记录穿过本机代理入口的字节数，不记录网址或报文', async () => {
    const live = await start()
    const before = live.traffic()
    await httpGetViaProxy(live.port(), 'http://foreign.test/')
    const after = live.traffic()
    expect(after.uploadBytes).toBeGreaterThan(before.uploadBytes)
    expect(after.downloadBytes).toBeGreaterThan(before.downloadBytes)
    expect(after.observedAt).toBeGreaterThan(0)
    expect(JSON.stringify(after)).not.toContain('foreign.test')
  })

  it('缺少内核时拒绝启动；端口占用时保留其他程序', async () => {
    const missing = createLocalBridge({ listenPort: 0, dataDir, routes: undefined, upstream: { host: '127.0.0.1', port: upstream.port }, executablePath: join(dataDir, 'missing') })
    await expect(missing.listen()).rejects.toThrow('代理内核缺失')
    const occupier = createServer()
    await new Promise<void>((resolve) => occupier.listen(0, '127.0.0.1', resolve))
    const address = occupier.address()
    if (address === null || typeof address === 'string') throw new Error('NO_LISTENER')
    bridge = createLocalBridge({ listenPort: address.port, dataDir, routes: undefined, upstream: { host: '127.0.0.1', port: upstream.port } })
    try {
      await expect(bridge.listen()).rejects.toMatchObject({ code: '端口占用' })
      expect(bridge.isAlive()).toBe(false)
      expect(occupier.listening).toBe(true)
    } finally {
      await new Promise<void>((resolve) => occupier.close(() => resolve()))
    }
  })

  it('缺少 GeoSite 数据时拒绝启动', async () => {
    const executablePath = join(dataDir, 'xray')
    writeFileSync(executablePath, 'placeholder-not-a-binary', { mode: 0o700 })
    writeFileSync(join(dataDir, 'geoip.dat'), 'placeholder', { mode: 0o600 })
    bridge = createLocalBridge({ listenPort: 0, dataDir, routes: undefined, upstream: { host: '127.0.0.1', port: upstream.port }, executablePath })
    await expect(bridge.listen()).rejects.toThrow('geosite.dat')
  })

  it('按复验→局域网名→DeepSeek→overlay→GeoSite/后缀→localhost→GeoIP 排序；未命中原样走 SSH', () => {
    const input = {
      listenPort: 18080,
      upstream: { host: '127.0.0.1', port: 18081 },
      verifyUrl: 'https://verify.example/ip',
      routes: {
        protectedDirectSuffixes: ['deepseek.com'],
        tunnelSuffixes: ['vendor.cn'],
        directSuffixes: ['cn', 'baidu.com']
      }
    }
    const config = buildXrayConfig(input)
    expect(config.routing.domainStrategy).toBe('AsIs')
    expect(config.routing.rules).toEqual([
      { type: 'field', inboundTag: ['local-mixed'], port: '443', domain: ['full:verify.example'], outboundTag: 'ssh-socks' },
      // 回显失败后的通用探测点同样必须经通道(创始人 09-13:回显服务抖一下 ⛔ 拆客户的网)
      { type: 'field', inboundTag: ['local-mixed'], port: '443', domain: ['full:www.gstatic.com'], outboundTag: 'ssh-socks' },
      { type: 'field', inboundTag: ['local-mixed'], port: '443', domain: ['full:cp.cloudflare.com'], outboundTag: 'ssh-socks' },
      // 局域网名排在 overlay 之前(D4):签名补充规则不能把 .local / home.arpa 送出去
      { type: 'field', domain: ['domain:local', 'domain:home.arpa', 'domain:localdomain'], outboundTag: 'direct' },
      { type: 'field', domain: ['domain:deepseek.com'], outboundTag: 'direct' },
      { type: 'field', domain: ['domain:vendor.cn'], outboundTag: 'ssh-socks' },
      { type: 'field', domain: ['geosite:cn'], outboundTag: 'direct' },
      { type: 'field', domain: ['domain:cn', 'domain:baidu.com'], outboundTag: 'direct' },
      { type: 'field', domain: ['domain:localhost'], outboundTag: 'direct' },
      { type: 'field', ip: ['geoip:private', 'geoip:cn'], outboundTag: 'direct' }
    ])
    expect(config.outbounds[0]).toMatchObject({ tag: 'ssh-socks', protocol: 'socks', streamSettings: { sockopt: { domainStrategy: 'AsIs' } } })
    expect(buildWindowsXrayConfig(input)).toEqual(config)
  })
})
