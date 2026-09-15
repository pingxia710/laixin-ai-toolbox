// CH-1(创始人 09-15 定):AI 和 GitHub 走专用出站,跟其他国外流量分开;国内仍直连。
// 三条验收对应三个 describe:
//  · 三类域名分流正确 —— 解释器与下发给内核的规则表同结论(route-regression 已钉结论,这里钉规则表)。
//  · 专用与通用互不影响 —— 规则表/出站结构互不指错;真内核 + 假上游掐一条入口,claude.ai 不跟着断。
//    (两路共享同一批入口是 01A 验证过的结构「共享故障域」;节点整体死了两路都死,那不是本条要守的事。)
//  · 单节点回归 —— 通用路径形状不变,专用出站是同一上游的镜像(行为与从前一致:同一节点承载)。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildXrayConfig, createLocalBridge, TUNNEL_BALANCER_TAG, TUNNEL_OUTBOUND_TAG } from '../../sidecar/mac/local-bridge.mjs'
import { composeRoutes } from '../../app/main/tunnel/package-format'
import { explainRoute } from '../../app/main/tunnel/route-explainer'
import { httpGetViaProxy, makeTempDir, removeTempDir, startFakeHttpMarker, startFakeSocks5Server } from './helpers'
import type { RouteTable } from '../../sidecar/mac/daemon-core.mjs'

const defaults = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../sidecar/shared/routes.default.json', import.meta.url)), 'utf8')
) as RouteTable

const routes = composeRoutes(defaults, undefined)
const dedicatedSuffixes = defaults.dedicatedSuffixes ?? []

const entry = (tag: string, port: number) => ({ tag, protocol: 'socks', settings: { servers: [{ address: '127.0.0.1', port }] } })

// 出站对象在类型声明里只有 tag;测试要动/读内嵌 servers,就地收窄。⛔ 为一个用例放宽产品的类型面。
type EntryOutbound = { tag: string; settings?: { servers?: Array<{ port?: number }> } }
const asEntry = (outbound: { tag: string }): EntryOutbound => outbound as EntryOutbound

describe('CH-1 · 三类域名在内核规则表里指向专用出站', () => {
  it('单节点配置:专用域名规则指向 dedicated 出站,先于 geosite:cn 与显式直连', () => {
    expect(dedicatedSuffixes.length, '基础分流表必须带有专用后缀').toBeGreaterThan(0)
    const config = buildXrayConfig({ listenPort: 18080, upstream: { host: '127.0.0.1', port: 1 }, routes })
    const rules = config.routing.rules
    const ruleOf = (suffix: string) => rules.find((rule) => rule.domain?.includes(`domain:${suffix}`))
    for (const suffix of dedicatedSuffixes) {
      expect(ruleOf(suffix)?.outboundTag, suffix).toBe('dedicated')
    }
    const dedicatedIndex = rules.findIndex((rule) => rule.outboundTag === 'dedicated')
    const geositeIndex = rules.findIndex((rule) => rule.domain?.includes('geosite:cn'))
    const directSuffixIndex = rules.findIndex((rule) => rule.domain?.includes('domain:cn'))
    expect(dedicatedIndex).toBeLessThan(geositeIndex)
    expect(dedicatedIndex).toBeLessThan(directSuffixIndex)
  })

  it('多入口配置:专用域名规则指向专用均衡器,与通用均衡器互不指错', () => {
    const config = buildXrayConfig({ listenPort: 18080, upstream: { host: '127.0.0.1', port: 1 }, outbounds: [entry('a', 7001), entry('b', 7002)], routes })
    const dedicatedRules = config.routing.rules.filter((rule) => rule.balancerTag === 'dedicated')
    const ruleDomains = dedicatedRules.flatMap((rule) => rule.domain ?? [])
    for (const suffix of dedicatedSuffixes) expect(ruleDomains).toContain(`domain:${suffix}`)
    expect(JSON.stringify(dedicatedRules)).not.toContain(`"${TUNNEL_BALANCER_TAG}"`)
    expect(JSON.stringify(config.routing.rules.filter((rule) => rule.balancerTag === TUNNEL_BALANCER_TAG))).not.toContain('dedicated')
  })

  it('别的国外域名与国内域名都不在专用表里:google 走通用(内核判),baidu/DeepSeek 直连', () => {
    for (const foreign of ['google.com', 'youtube.com', 'wikipedia.org']) {
      expect(dedicatedSuffixes.some((suffix) => foreign === suffix || foreign.endsWith(`.${suffix}`)), foreign).toBe(false)
      expect(explainRoute(foreign, routes).outcome).toBe('kernel-check')
    }
    expect(explainRoute('www.baidu.com', routes).outcome).toBe('direct')
    expect(explainRoute('api.deepseek.com', routes)).toMatchObject({ outcome: 'direct', reasonCode: 'PROTECTED_DIRECT' })
  })
})

describe('CH-1 · 通用通道故障不影响专用路径', () => {
  it('结构互不依赖:把通用出站全部弄坏(指向死口),专用出站与专用规则原样不动', () => {
    const config = buildXrayConfig({ listenPort: 18080, upstream: { host: '127.0.0.1', port: 1 }, outbounds: [entry('a', 7001), entry('b', 7002)], routes })
    const broken = structuredClone(config) as typeof config
    // 「通用通道故障」:通用组的每条入口出站都指向没人听的口,并拆掉通用均衡器
    for (const candidate of broken.outbounds) {
      const outbound = asEntry(candidate)
      if (outbound.tag.startsWith(`${TUNNEL_BALANCER_TAG}-`)) {
        const server = outbound.settings?.servers?.[0]
        if (server) server.port = 1
      }
    }
    broken.routing.balancers = (broken.routing.balancers ?? []).filter((balancer) => balancer.tag !== TUNNEL_BALANCER_TAG)
    // 专用侧逐字节不变:出站、专用规则、探活配置原样
    expect(broken.outbounds.filter((outbound) => outbound.tag.startsWith('dedicated-')))
      .toEqual(config.outbounds.filter((outbound) => outbound.tag.startsWith('dedicated-')))
    expect(broken.routing.rules.filter((rule) => rule.balancerTag === 'dedicated'))
      .toEqual(config.routing.rules.filter((rule) => rule.balancerTag === 'dedicated'))
    expect(broken.observatory).toEqual(config.observatory)
    // 通用侧确实被弄坏了(变异本身有效,⛔ 空转的断言)
    expect(broken.outbounds.filter((outbound) => outbound.tag.startsWith(`${TUNNEL_BALANCER_TAG}-`))
      .every((outbound) => asEntry(outbound).settings?.servers?.[0]?.port === 1)).toBe(true)
  })

  it('真内核:掐掉一条入口(通用通道故障),claude.ai 与 github.com 继续走通', async () => {
    const dataDir = makeTempDir('toolbox-dedicated-')
    const target = await startFakeHttpMarker('DEDICATED-OK')
      // 探活也只打本机标记:⛔ 用缺省的 gstatic/cloudflare,离线环境会把两条入口都误判成死,演练失真
      const dial: Record<string, [string, number]> = {
        'claude.ai:80': ['127.0.0.1', target.port],
        'github.com:80': ['127.0.0.1', target.port],
        [`127.0.0.1:${String(target.port)}`]: ['127.0.0.1', target.port]
      }
      const upstreamA = await startFakeSocks5Server(dial)
      const upstreamB = await startFakeSocks5Server(dial)
      let bridge: ReturnType<typeof createLocalBridge> | undefined
      try {
        bridge = createLocalBridge({
          listenPort: 0, dataDir, upstream: { host: '127.0.0.1', port: upstreamA.port },
          outbounds: [entry('a', upstreamA.port), entry('b', upstreamB.port)],
          routes, probeIntervalSeconds: 1,
          probeUrls: [`http://127.0.0.1:${String(target.port)}/probe204`]
        })
      await bridge.listen()
      const viaProxy = (host: string) => httpGetViaProxy(bridge!.port(), `http://${host}/`)
      // 掐之前:专用域名真的穿通道到达目标(假上游记到 CONNECT 域名)
      expect(await viaProxy('claude.ai')).toContain('DEDICATED-OK')
      expect([...upstreamA.hits(), ...upstreamB.hits()].some((hit) => hit.host === 'claude.ai')).toBe(true)
      // 造通用通道故障:整条入口 A 停服
      await upstreamA.close()
      // 专用路径不受影响:轮询窗口内 claude.ai / github.com 继续可达(经另一条入口)
      const deadline = Date.now() + 15_000
      let claudeOk = false
      let githubOk = false
      while (Date.now() < deadline && !(claudeOk && githubOk)) {
        try { if (!claudeOk) claudeOk = (await viaProxy('claude.ai')).includes('DEDICATED-OK') } catch { /* 入口切换窗口内会失败,继续等 */ }
        try { if (!githubOk) githubOk = (await viaProxy('github.com')).includes('DEDICATED-OK') } catch { /* 同上 */ }
        if (!(claudeOk && githubOk)) await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(claudeOk, 'claude.ai 在入口故障后 15 秒内未恢复').toBe(true)
      expect(githubOk, 'github.com 在入口故障后 15 秒内未恢复').toBe(true)
    } finally {
      await bridge?.close()
      await upstreamB.close()
      await target.close()
      removeTempDir(dataDir)
    }
  }, 30_000)

  it('真内核:上游全断时专用路径不回退直连(断就断,⛔ 假装还通)', async () => {
    const dataDir = makeTempDir('toolbox-dedicated-nofallback-')
    const target = await startFakeHttpMarker('DEDICATED-NOFALLBACK')
    const upstream = await startFakeSocks5Server({ 'claude.ai:80': ['127.0.0.1', target.port] })
    let bridge: ReturnType<typeof createLocalBridge> | undefined
    try {
      bridge = createLocalBridge({ listenPort: 0, dataDir, upstream: { host: '127.0.0.1', port: upstream.port }, routes })
      await bridge.listen()
      await upstream.close()
      // localhost 有确实可达的直连目标:若专用规则错误回退直连,标记会被打到
      const body = await httpGetViaProxy(bridge.port(), `http://claude.ai/`).catch((error: unknown) => String(error))
      expect(body).not.toContain('DEDICATED-NOFALLBACK')
      expect(target.requestCount()).toBe(0)
    } finally {
      await bridge?.close()
      await target.close()
      removeTempDir(dataDir)
    }
  }, 20_000)
})

describe('CH-1 · 单节点回归:通用路径与从前同形,专用只是同上游的镜像', () => {
  it('通用出站、通用规则、直连规则与「无专用表」的基线逐字节一致;没有探活与均衡器', () => {
    const withoutDedicated = { ...defaults, dedicatedSuffixes: [] as readonly string[] }
    const baseline = buildXrayConfig({ listenPort: 18080, upstream: { host: '127.0.0.1', port: 1 }, routes: composeRoutes(withoutDedicated, undefined) })
    const current = buildXrayConfig({ listenPort: 18080, upstream: { host: '127.0.0.1', port: 1 }, routes })
    // 出站:多出来的只有 dedicated,且它是通用出站的镜像(同上游同配置) —— 流量仍由同一节点承载
    expect(current.outbounds.map((outbound) => outbound.tag)).toEqual([...baseline.outbounds.map((outbound) => outbound.tag).slice(0, 1), 'dedicated', 'direct'])
    expect(current.outbounds[1]).toEqual({ ...current.outbounds[0], tag: 'dedicated' })
    // 规则:多出来的只有专用那一块,其余逐条一致(顺序也一致)
    const dedicatedIndex = current.routing.rules.findIndex((rule) => rule.outboundTag === 'dedicated')
    const withoutDedicatedRules = current.routing.rules.filter((_, index) => index !== dedicatedIndex)
    expect(withoutDedicatedRules).toEqual(baseline.routing.rules)
    // 单节点没有探活与均衡器:客户套餐不因此多一笔探测流量,故障转移语义不变
    expect(current.observatory).toBeUndefined()
    expect(current.routing.balancers).toBeUndefined()
    expect(JSON.stringify(current.routing)).not.toContain('balancerTag')
  })
})

describe('CH-1 · 出站 tag 常量在位', () => {
  it('单节点配置用出站 tag「dedicated」;多入口用均衡器「dedicated」,与 TUNNEL 常量互不混用', () => {
    expect(TUNNEL_OUTBOUND_TAG).toBe('ssh-socks')
    expect(TUNNEL_BALANCER_TAG).toBe('tunnel')
    const single = buildXrayConfig({ listenPort: 18080, upstream: { host: '127.0.0.1', port: 1 }, routes })
    expect(single.routing.rules.some((rule) => rule.outboundTag === 'dedicated')).toBe(true)
    const multi = buildXrayConfig({ listenPort: 18080, upstream: { host: '127.0.0.1', port: 1 }, outbounds: [entry('a', 7001), entry('b', 7002)], routes })
    expect(multi.routing.rules.some((rule) => rule.balancerTag === 'dedicated')).toBe(true)
  })
})
