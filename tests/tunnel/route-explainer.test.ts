import { describe, expect, it } from 'vitest'
import { explainRoute } from '../../app/main/tunnel/route-explainer'

const routes = {
  protectedDirectSuffixes: ['deepseek.com'],
  dedicatedSuffixes: ['claude.ai', 'openai.com', 'github.com'],
  tunnelSuffixes: ['vendor.cn'],
  directSuffixes: ['baidu.com', 'example.cn']
} as const

describe('通道路由解释', () => {
  it('按实际 Xray 优先级说明受保护直连、专用通道、签名通道补充和显式直连', () => {
    expect(explainRoute('api.deepseek.com', routes)).toMatchObject({ outcome: 'direct', reasonCode: 'PROTECTED_DIRECT' })
    expect(explainRoute('claude.ai', routes)).toMatchObject({ outcome: 'dedicated', reasonCode: 'DEDICATED_TUNNEL_SUFFIX' })
    expect(explainRoute('api.openai.com', routes)).toMatchObject({ outcome: 'dedicated', reasonCode: 'DEDICATED_TUNNEL_SUFFIX' })
    expect(explainRoute('gist.github.com', routes)).toMatchObject({ outcome: 'dedicated', reasonCode: 'DEDICATED_TUNNEL_SUFFIX', matchedRule: 'github.com' })
    expect(explainRoute('vendor.cn', routes)).toMatchObject({ outcome: 'tunnel', reasonCode: 'SIGNED_TUNNEL_SUFFIX' })
    expect(explainRoute('www.baidu.com', routes)).toMatchObject({ outcome: 'direct', reasonCode: 'EXPLICIT_DIRECT_SUFFIX' })
  })

  it('专用说得出「与其余国外的通用出站分开」,其余国外不冒充专用', () => {
    const claude = explainRoute('claude.ai', routes)
    expect(claude.title).toContain('专用')
    expect(claude.detail).toContain('通用')
    expect(explainRoute('unlisted.example', routes)).toMatchObject({ outcome: 'kernel-check' })
  })

  it('不会把 GeoSite 或 GeoIP 的未知结果伪装成确定的通道结论', () => {
    expect(explainRoute('unlisted.example', routes)).toMatchObject({ outcome: 'kernel-check', reasonCode: 'XRAY_GEOSITE_OR_DEFAULT' })
    // 公网地址、组播、以及 CGNAT 这种各份 geoip 数据未必一致的段:说不准就交给内核判(D4)
    for (const address of ['8.8.8.8', '1.1.1.1', 'ff00::1', '100.64.0.1', '2001:4860:4860::8888']) {
      expect(explainRoute(address, routes)).toMatchObject({ outcome: 'kernel-check', reasonCode: 'XRAY_GEOIP' })
    }
  })

  it('局域网地址与局域网名给确定结论:它们由我们自己写进配置的规则决定(D4)', () => {
    for (const address of ['10.0.0.1', '192.168.1.10', '172.16.0.1', '172.31.255.254', '169.254.1.1', '127.0.0.1', '::1', 'fd00::1', 'fe80::1']) {
      expect(explainRoute(address, routes), address).toMatchObject({ outcome: 'direct', reasonCode: 'PRIVATE_IP_DIRECT' })
    }
    for (const host of ['printer.local', 'nas.home.arpa', 'server.localdomain']) {
      expect(explainRoute(host, routes), host).toMatchObject({ outcome: 'direct', reasonCode: 'LOCAL_NETWORK_DIRECT' })
    }
    // localhost 的位置(后缀表之后)是既有约定,本包不动
    for (const host of ['localhost', 'app.localhost']) {
      expect(explainRoute(host, routes), host).toMatchObject({ outcome: 'direct', reasonCode: 'LOCALHOST' })
    }
  })

  it('说得出命中的是哪一条规则,而不是只说命中了某一类(D4)', () => {
    expect(explainRoute('api.deepseek.com', routes)).toMatchObject({ matchedRule: 'deepseek.com' })
    expect(explainRoute('sub.vendor.cn', routes)).toMatchObject({ matchedRule: 'vendor.cn' })
    expect(explainRoute('www.baidu.com', routes)).toMatchObject({ matchedRule: 'baidu.com' })
    expect(explainRoute('printer.local', routes)).toMatchObject({ matchedRule: 'local' })
    expect(explainRoute('192.168.1.1', routes)).toMatchObject({ matchedRule: 'geoip:private' })
    expect(explainRoute('api.deepseek.com', routes).detail).toContain('deepseek.com')
    // 判不出的照旧留空,⛔ 编一条规则名出来
    expect(explainRoute('unlisted.example', routes)).toMatchObject({ matchedRule: '' })
    expect(explainRoute('8.8.8.8', routes)).toMatchObject({ matchedRule: '' })
  })

  it('拒绝 URL、端口、路径和非法域名输入', () => {
    for (const value of ['https://api.deepseek.com', 'api.deepseek.com:443', 'api.deepseek.com/path', '..deepseek.com', '']) {
      expect(explainRoute(value, routes)).toMatchObject({ outcome: 'invalid', reasonCode: 'HOST_INVALID' })
    }
  })
})
