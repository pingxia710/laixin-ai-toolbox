// 「注册表/网络设置里那个代理是不是我们自己的」——判据是**查我们用过哪些口**，⛔ 靠端口长什么样猜。
//
// 原判据是正则 /^18[0-9]80$/。候选口(18080→18180→…→18480)被占完时守护会退回系统随机分配，
// 那个口不长那样，于是我们自己上次留下的代理会被认成「客户的第三方代理」：接管时把它当成客户的
// 原值记进账本，客户退出时我们再"忠实地"把他还原成一个指向死端口的代理。
import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAdapter as createWinAdapter } from './fixtures/fake-wininet-adapter.mjs'
import { isOurProxy, ourPorts } from '../../sidecar/win/proxy-identity.mjs'
import { lastBridgePort } from '../../sidecar/win/daemon-core.mjs'
import { makeTempDir, removeTempDir } from './helpers'

function winAdapterWith(proxyServer: string, store: string) {
  writeFileSync(store, JSON.stringify({
    ProxyEnable: { type: 'REG_DWORD', data: '1' },
    ProxyServer: { type: 'REG_SZ', data: proxyServer }
  }))
  return createWinAdapter({ FAKE_WININET_STORE: store })
}

describe('认出「这是我们自己的口」', () => {
  it('系统随机分配的高位口也认得出——只要守护把它报上来', () => {
    const dir = makeTempDir('our-port-')
    const store = join(dir, 'registry.json')
    const adapter = winAdapterWith('127.0.0.1:51234', store)
    // 正向证据：不带记录时它确实被当成第三方（说明这条用例在区分两种真实形态，不是恒真）
    expect(adapter.existingProxy({ host: '127.0.0.1', port: 18080 })).toMatchObject({ host: '127.0.0.1', port: 51234 })
    // 守护把上一轮实际用的口报上来 → 认出是自己的
    expect(adapter.existingProxy({ host: '127.0.0.1', port: 18080, knownPorts: [18080, 51234] })).toBeUndefined()
    removeTempDir(dir)
  })

  it('客户自己的本地代理 ⛔ 被认成我们的（认宽了会误伤他的 Clash）', () => {
    const dir = makeTempDir('our-port-')
    const store = join(dir, 'registry.json')
    const adapter = winAdapterWith('127.0.0.1:7890', store)
    expect(adapter.existingProxy({ host: '127.0.0.1', port: 18080, knownPorts: [18080, 18180, 51234] }))
      .toMatchObject({ host: '127.0.0.1', port: 7890 })
    removeTempDir(dir)
  })

  it('候选表里的口照旧认得出', () => {
    const dir = makeTempDir('our-port-')
    const store = join(dir, 'registry.json')
    const adapter = winAdapterWith('127.0.0.1:18280', store)
    expect(adapter.existingProxy({ host: '127.0.0.1', port: 18080, knownPorts: [18080, 18180, 18280, 18380, 18480] })).toBeUndefined()
    removeTempDir(dir)
  })

  it('判据本身:端口不在记录里就不是我们的,⛔ 靠端口长什么样猜', () => {
    // 原判据是 /^18[0-9]80$/：18080 长得"像"就认，51234 不像就不认——与事实无关
    expect(isOurProxy({ host: '127.0.0.1', port: 18080 }, { host: '127.0.0.1', port: 9999, knownPorts: [] })).toBe(false)
    expect(isOurProxy({ host: '127.0.0.1', port: 51234 }, { host: '127.0.0.1', port: 18080, knownPorts: [51234] })).toBe(true)
    // host 不一样就不是我们的（客户在局域网另一台机器上的代理）
    expect(isOurProxy({ host: '192.168.1.9', port: 18080 }, { host: '127.0.0.1', port: 18080 })).toBe(false)
    // 脏数据不该混进记录
    expect(ourPorts({ port: 18080, knownPorts: [0, -1, 1.5, Number.NaN, 51234] as unknown as number[] })).toEqual(new Set([18080, 51234]))
  })

  it('上一轮的实际端口从 state.json 读得回来（守护据此汇总 knownPorts）', () => {
    const dir = makeTempDir('our-port-')
    expect(lastBridgePort(dir)).toBeUndefined()
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ state: 'connected', bridgePort: 51234, updatedAt: 1 }))
    expect(lastBridgePort(dir)).toBe(51234)
    // 状态文件坏了不该抛——读不到就是读不到
    writeFileSync(join(dir, 'state.json'), '{半截')
    expect(lastBridgePort(dir)).toBeUndefined()
    removeTempDir(dir)
  })
})
