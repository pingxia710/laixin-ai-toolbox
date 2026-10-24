// 隐藏多节点（创始人 09-13 晚放行）：一份授权带多个入口，内核自己探活择路，某条被掐掉时客户几乎无感；
// 客户界面上仍只有「连接」，⛔ 节点列表、⛔ 让客户选。
// CH-1（创始人 09-15）后单入口出站多一个「专用镜像」（同上游、独立出站），探活与均衡器仍只属于多入口。
// 这里两层都验：① Xray 配置形状（单入口没有探活/均衡器，专用与通用同一上游）；② 真 Xray 配置校验。
import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer as netServer } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildXrayConfig, TUNNEL_BALANCER_TAG, TUNNEL_OUTBOUND_TAG } from '../../sidecar/mac/local-bridge.mjs'
import { makeTempDir, removeTempDir } from './helpers'


const XRAY_DIR = fileURLToPath(new URL('../../vendor/xray/mac-arm64', import.meta.url))
const XRAY_BIN = join(XRAY_DIR, 'xray')

const cleanups: (() => Promise<unknown> | void)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const freePort = () => new Promise<number>((resolve) => {
  const probe = netServer(); probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)) })
})

describe('隐藏多节点 · Xray 配置形状', () => {
  // openai.com 同时挂在专用表和签名补充表上:专用规则必须先于签名补充规则命中(CH-1 排序)。
  const base = { listenPort: 1080, upstream: { host: '127.0.0.1', port: 1 }, routes: { directSuffixes: [], protectedDirectSuffixes: [], dedicatedSuffixes: ['openai.com'], tunnelSuffixes: ['openai.com'] } }
  const entry = (tag: string, port: number) => ({ tag, protocol: 'socks', settings: { servers: [{ address: '127.0.0.1', port }] } })

  it('单入口:出站变成「通用 + 专用镜像 + 直连」,专用与通用指同一上游,探活与均衡器仍只属于多入口', () => {
    const config = buildXrayConfig({ ...base, outbound: entry('whatever', 7001) })
    expect(config.outbounds.map((out) => out.tag)).toEqual([TUNNEL_OUTBOUND_TAG, 'dedicated', 'direct'])
    // 专用出站与通用出站同址同配置:单节点包的流量行为与从前一致(同一节点承载),只是结构上分开
    expect(config.outbounds[1]).toEqual({ ...entry('whatever', 7001), tag: 'dedicated' })
    expect(config.observatory).toBeUndefined()
    expect(config.routing.balancers).toBeUndefined()
    expect(config.routing.rules.some((rule) => rule.outboundTag === TUNNEL_OUTBOUND_TAG)).toBe(true)
    expect(config.routing.rules.some((rule) => rule.outboundTag === 'dedicated')).toBe(true)
    expect(JSON.stringify(config)).not.toContain('balancerTag')
  })

  it('只给一个入口的数组:等同单入口', () => {
    const config = buildXrayConfig({ ...base, outbounds: [entry('x', 7001)] })
    expect(config.outbounds.map((out) => out.tag)).toEqual([TUNNEL_OUTBOUND_TAG, 'dedicated', 'direct'])
    expect(config.observatory).toBeUndefined()
  })

  it('多入口:通用与专用各一套入口出站 + 各自的均衡器,探活两组都照,专用规则不沾通用 tag', () => {
    const config = buildXrayConfig({ ...base, outbounds: [entry('a', 7001), entry('b', 7002), entry('c', 7003)] })
    expect(config.outbounds.map((out) => out.tag)).toEqual([
      `${TUNNEL_BALANCER_TAG}-0`, `${TUNNEL_BALANCER_TAG}-1`, `${TUNNEL_BALANCER_TAG}-2`,
      'dedicated-0', 'dedicated-1', 'dedicated-2', 'direct'
    ])
    // 专用组逐项镜像通用组:同一批入口、独立出站对象(独立连接路径),⛔ 指到别的服务器
    for (let index = 0; index < 3; index++) {
      const general = config.outbounds[index]
      expect(config.outbounds[3 + index]).toEqual({ ...general, tag: `dedicated-${String(index)}` })
    }
    expect(config.observatory?.subjectSelector).toEqual([`${TUNNEL_BALANCER_TAG}-`, 'dedicated-'])
    expect(config.routing.balancers).toEqual([
      { tag: TUNNEL_BALANCER_TAG, selector: [`${TUNNEL_BALANCER_TAG}-`], strategy: { type: 'leastPing' } },
      { tag: 'dedicated', selector: ['dedicated-'], strategy: { type: 'leastPing' } }
    ])
    // 通道规则一条都不能还指着老 tag,否则那条流量会落到不存在的出站
    expect(JSON.stringify(config.routing.rules)).not.toContain(TUNNEL_OUTBOUND_TAG)
    // 专用域名走专用均衡器;通用与专用互不指错(两条路真的分开)
    const dedicatedRules = config.routing.rules.filter((rule) => rule.balancerTag === 'dedicated')
    expect(dedicatedRules.length).toBeGreaterThan(0)
    expect(JSON.stringify(dedicatedRules)).not.toContain(TUNNEL_BALANCER_TAG)
    expect(JSON.stringify(config.routing.rules.filter((rule) => rule.balancerTag === TUNNEL_BALANCER_TAG))).not.toContain('dedicated')
    // 专用规则先于签名补充规则命中:同一域名两处都写了,取前面的专用
    const dedicatedIndex = config.routing.rules.findIndex((rule) => rule.balancerTag === 'dedicated')
    const signedIndex = config.routing.rules.findIndex((rule) => rule.balancerTag === TUNNEL_BALANCER_TAG && rule.domain?.includes('domain:openai.com'))
    expect(dedicatedIndex).toBeLessThan(signedIndex)
    // 国内直连规则不受影响
    expect(config.routing.rules.some((rule) => rule.domain?.includes('geosite:cn') && rule.outboundTag === 'direct')).toBe(true)
  })

  it('路由表没写专用域名时,配置与从前同形(不冒出没人用的出站)', () => {
    const config = buildXrayConfig({ ...base, routes: { directSuffixes: [], protectedDirectSuffixes: [], tunnelSuffixes: ['vendor.cn'] }, outbounds: [entry('a', 7001)] })
    expect(config.outbounds.map((out) => out.tag)).toEqual([TUNNEL_OUTBOUND_TAG, 'direct'])
    expect(JSON.stringify(config)).not.toContain('dedicated')
  })

  it('生成的多入口配置能被随包 Xray 接受（配置校验，不是我们自己说了算）', async () => {
    const dir = makeTempDir('multi-entry-config-'); cleanups.push(() => removeTempDir(dir))
    const config = buildXrayConfig({ ...base, listenPort: await freePort(), outbounds: [entry('a', 7001), entry('b', 7002)] })
    const path = join(dir, 'config.json'); writeFileSync(path, JSON.stringify(config))
    const result = spawn(XRAY_BIN, ['run', '-test', '-config', path], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XRAY_LOCATION_ASSET: XRAY_DIR } })
    let out = ''
    result.stdout.on('data', (chunk) => { out += String(chunk) }); result.stderr.on('data', (chunk) => { out += String(chunk) })
    const code = await new Promise<number>((resolve) => result.on('exit', (value) => resolve(value ?? -1)))
    expect(out).toContain('Configuration OK')
    expect(code).toBe(0)
  })
})

// 「掐掉正在用的那条入口，客户请求自动改走另一条」属于真内核 + 真进程一类，与成品级核验同处：
// `node scripts/verify-multi-entry.mjs`（两个各自记账的上游 + 随包 Xray，掐一条看切换与耗时）。
