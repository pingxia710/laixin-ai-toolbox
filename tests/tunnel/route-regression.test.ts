// D4(0.4.9 网络组):国内直连与分流正确性的固定回归目标。
// 这组目标在规则更新(签名 overlay、默认分流表改动)前后都要保持同一结论——
// 「国内应用受影响」是客户最直接的投诉,一条国内域名被误划进通道就是一次事故。
// 两个角度各验一遍:①主进程解释器(给客户看的结论);②真正下发给内核的 Xray 规则表。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildXrayConfig, LOCAL_NETWORK_DIRECT_SUFFIXES } from '../../sidecar/mac/local-bridge.mjs'
import { composeRoutes } from '../../app/main/tunnel/package-format'
import { explainRoute } from '../../app/main/tunnel/route-explainer'
import type { RouteTable } from '../../sidecar/mac/daemon-core.mjs'

const defaults = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../sidecar/shared/routes.default.json', import.meta.url)), 'utf8')
) as RouteTable

type Expected = 'direct' | 'tunnel' | 'dedicated' | 'kernel-check'

// 「直连」= 我们自己写进配置的规则说了算,说得出;
// 「内核判断」= 交给 geosite:cn / geoip 判,我们不猜(⛔ 把不确定说成确定);
// 「专用」= CH-1(创始人 09-15):AI 和 GitHub 走专用出站,与其余国外流量的通用出站分开。
const TARGETS: ReadonlyArray<readonly [string, Expected, string]> = [
  // 国内模型 API 四家
  ['api.deepseek.com', 'direct', 'DeepSeek:受保护直连,签名规则也改不动'],
  ['api.moonshot.cn', 'direct', 'Kimi 开放平台'],
  ['api.kimi.com', 'direct', 'Kimi'],
  ['open.bigmodel.cn', 'direct', '智谱开放平台'],
  // 常用办公
  ['wx.qq.com', 'direct', '微信'],
  ['weixin.qq.com', 'direct', '微信'],
  ['oapi.dingtalk.com', 'direct', '钉钉'],
  ['open.feishu.cn', 'direct', '飞书'],
  ['www.larksuite.com', 'direct', '飞书国际版'],
  ['pan.baidu.com', 'direct', '百度网盘'],
  ['gips0.baidu.com', 'direct', '百度网盘'],
  ['pcs.baidu.com', 'direct', '百度网盘传输域'],
  ['www.taobao.com', 'direct', '淘宝'],
  ['img.alicdn.com', 'direct', '淘宝静态资源'],
  ['b.bdstatic.com', 'direct', '百度静态资源'],
  // 局域网与 mDNS
  ['192.168.1.1', 'direct', '家用路由器'],
  ['10.1.2.3', 'direct', '公司内网'],
  ['172.16.0.5', 'direct', '公司内网'],
  ['172.31.255.254', 'direct', '公司内网(段尾)'],
  ['169.254.1.1', 'direct', '链路本地'],
  ['printer.local', 'direct', 'mDNS 打印机'],
  ['nas.local', 'direct', 'mDNS NAS'],
  ['router.home.arpa', 'direct', '家庭网标准域'],
  ['localhost', 'direct', '本机'],
  // 境外:专用通道(Claude/Anthropic、OpenAI/ChatGPT、GitHub)与其余国外(通用)分得开
  ['claude.ai', 'dedicated', 'Claude:专用出站'],
  ['api.anthropic.com', 'dedicated', 'Anthropic API:专用出站'],
  ['api.openai.com', 'dedicated', 'OpenAI API:专用出站'],
  ['chatgpt.com', 'dedicated', 'ChatGPT:专用出站'],
  ['ab.chatgpt.com', 'dedicated', 'ChatGPT 子域:专用出站'],
  ['github.com', 'dedicated', 'GitHub:专用出站'],
  ['raw.githubusercontent.com', 'dedicated', 'GitHub 内容域:专用出站'],
  // 别的国外域名:不是专用,走通用通道(先交内核查国内域名库,未命中走通用)
  ['www.google.com', 'kernel-check', '其余国外:先查国内域名库,未命中才走通用通道'],
  ['8.8.8.8', 'kernel-check', '境外公网 IP 交 GeoIP 判']
]

const routes = composeRoutes(defaults, undefined)

describe('D4 固定回归目标:规则更新前后结论不变', () => {
  it.each(TARGETS)('%s → %s(%s)', (host, expected) => {
    expect(explainRoute(host, routes).outcome).toBe(expected)
  })

  it('下发给内核的 Xray 规则表与解释器结论一致:本机网络名与受保护域名排在通道规则之前', () => {
    const config = buildXrayConfig({ listenPort: 18080, upstream: { host: '127.0.0.1', port: 1 }, routes })
    const rules = config.routing.rules
    const outboundOf = (suffix: string) =>
      rules.find((rule) => rule.domain?.includes(`domain:${suffix}`))?.outboundTag
    for (const suffix of LOCAL_NETWORK_DIRECT_SUFFIXES) {
      expect(outboundOf(suffix), suffix).toBe('direct')
    }
    for (const suffix of defaults.protectedDirectSuffixes) {
      expect(outboundOf(suffix), suffix).toBe('direct')
    }
    // 本机网络名必须排在任何通道规则之前:Xray 按顺序取第一条命中的规则
    const firstTunnelIndex = rules.findIndex((rule) => rule.outboundTag === 'ssh-socks' && rule.domain !== undefined)
    const localIndex = rules.findIndex((rule) => rule.domain?.includes('domain:local'))
    expect(localIndex).toBeGreaterThanOrEqual(0)
    if (firstTunnelIndex >= 0) expect(localIndex).toBeLessThan(firstTunnelIndex)
    // 私有地址直连规则在位
    expect(rules.some((rule) => rule.ip?.includes('geoip:private') && rule.outboundTag === 'direct')).toBe(true)
  })

  it('CH-1:专用域名在内核规则表里指向专用出站,且受保护直连先于专用、专用先于普通直连', () => {
    const dedicated = defaults.dedicatedSuffixes ?? []
    expect(dedicated.length, '基础分流表必须带有专用后缀').toBeGreaterThan(0)
    const config = buildXrayConfig({ listenPort: 18080, upstream: { host: '127.0.0.1', port: 1 }, routes })
    const rules = config.routing.rules
    for (const suffix of dedicated) {
      expect(outboundOfDefault(rules, suffix), suffix).toBe('dedicated')
    }
    const protectedIndex = rules.findIndex((rule) => rule.domain?.includes('domain:deepseek.com'))
    const dedicatedIndex = rules.findIndex((rule) => rule.outboundTag === 'dedicated' && rule.domain !== undefined)
    const geositeIndex = rules.findIndex((rule) => rule.domain?.includes('geosite:cn'))
    // 通道类规则(专用在内)先于普通直连规则;DeepSeek 保护直连先于一切通道规则,⛔ 被专用覆盖
    expect(dedicatedIndex).toBeGreaterThanOrEqual(0)
    expect(protectedIndex).toBeGreaterThanOrEqual(0)
    expect(protectedIndex).toBeLessThan(dedicatedIndex)
    expect(dedicatedIndex).toBeLessThan(geositeIndex)
    // 解释器与规则表同一结论:三类域名说得出「专用」,其余国外不冒充专用
    expect(explainRoute('claude.ai', routes).outcome).toBe('dedicated')
    expect(explainRoute('www.google.com', routes).outcome).toBe('kernel-check')
  })

  // 坏配方:签名补充规则把国内域名划进通道。这组回归必须因此变红,
  // ⛔ 让一次规则更新悄悄把微信、淘宝、钉钉送出境。
  it('坏配方把国内域名误划进通道时,这组回归必红', () => {
    const poisoned = composeRoutes(defaults, { tunnelDomains: ['qq.com', 'taobao.com', 'dingtalk.com'] })
    const broken = TARGETS.filter(([host, expected]) => explainRoute(host, poisoned).outcome !== expected)
    expect(broken.map(([host]) => host)).toEqual(['wx.qq.com', 'weixin.qq.com', 'oapi.dingtalk.com', 'www.taobao.com'])
    expect(explainRoute('wx.qq.com', poisoned)).toMatchObject({ outcome: 'tunnel', reasonCode: 'SIGNED_TUNNEL_SUFFIX' })
  })

  it('坏配方 ⛔ 动得了受保护域名与本机网络名', () => {
    const poisoned = composeRoutes(defaults, { tunnelDomains: ['deepseek.com', 'local', 'localhost'] })
    expect(explainRoute('api.deepseek.com', poisoned)).toMatchObject({ outcome: 'direct', reasonCode: 'PROTECTED_DIRECT' })
    expect(explainRoute('printer.local', poisoned)).toMatchObject({ outcome: 'direct', reasonCode: 'LOCAL_NETWORK_DIRECT' })
    const config = buildXrayConfig({ listenPort: 18080, upstream: { host: '127.0.0.1', port: 1 }, routes: poisoned })
    const localIndex = config.routing.rules.findIndex((rule) => rule.domain?.includes('domain:local'))
    const tunnelIndex = config.routing.rules.findIndex((rule) => rule.outboundTag === 'ssh-socks' && rule.domain?.includes('domain:local'))
    expect(localIndex).toBeLessThan(tunnelIndex) // 先命中直连,通道那条够不着
  })
})

// 规则块里找「domain:<suffix> 命中时的出站 tag」:找不到返回 undefined,由调用方断言。
function outboundOfDefault(rules: Array<{ domain?: string[]; outboundTag?: string }>, suffix: string): string | undefined {
  return rules.find((rule) => rule.domain?.includes(`domain:${suffix}`))?.outboundTag
}
