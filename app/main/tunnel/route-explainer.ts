import { isIP } from 'node:net'
import { LOCAL_NETWORK_DIRECT_SUFFIXES } from '../../../sidecar/mac/local-bridge.mjs'
import type { RouteTable } from '../../../sidecar/mac/daemon-core.mjs'

export interface RouteExplanation {
  readonly outcome: 'direct' | 'tunnel' | 'dedicated' | 'kernel-check' | 'invalid' | 'unconfigured'
  readonly reasonCode: string
  readonly title: string
  readonly detail: string
  /** 具体命中的那一条:后缀(qq.com)或内核规则名(geosite:cn / geoip:private)。判不出时为空。 */
  readonly matchedRule: string
}

export function routeUnavailable(): RouteExplanation {
  return {
    outcome: 'unconfigured', reasonCode: 'ROUTE_CONFIG_UNAVAILABLE', title: '尚无可用分流配置',
    detail: '请先领取或导入并应用来信配置，再查看当前分流说明。', matchedRule: ''
  }
}

const invalid: RouteExplanation = {
  outcome: 'invalid', reasonCode: 'HOST_INVALID', title: '请输入域名或 IP 地址',
  detail: '这里只检查主机名，不接受网址、端口或路径。', matchedRule: ''
}

/**
 * Mirrors the explicit Xray rule order. GeoSite/GeoIP databases remain inside Xray,
 * so an unmatched public host is intentionally reported as a kernel check instead of
 * guessed as a tunnel route.
 */
export function explainRoute(input: string, routes: RouteTable): RouteExplanation {
  const host = normalizeHost(input)
  if (!host) return invalid
  if (isIP(host)) {
    // 局域网与本机地址由 geoip:private 规则确定直连,说得出就 ⛔ 含糊成「等内核判断」。
    if (isPrivateAddress(host)) {
      return direct('PRIVATE_IP_DIRECT', '局域网地址直连', '匹配内核的私有地址规则（geoip:private），局域网设备不经过来信通道。', 'geoip:private')
    }
    return kernelCheck('XRAY_GEOIP', '由内核判断 IP 路由', 'Xray 会按当前 GeoIP 规则决定 IP 地址直连或走通道；这里不猜测结果。', '')
  }
  // 局域网名排在最前:签名补充规则也不能把局域网里的名字送出去。
  const localName = matchedSuffix(host, LOCAL_NETWORK_DIRECT_SUFFIXES)
  if (localName !== undefined) {
    return direct('LOCAL_NETWORK_DIRECT', '局域网名直连', `匹配局域网名规则「${localName}」，局域网设备不经过来信通道。`, localName)
  }
  const protectedSuffix = matchedSuffix(host, routes.protectedDirectSuffixes)
  if (protectedSuffix !== undefined) {
    return direct('PROTECTED_DIRECT', '受保护域名直连', `匹配受保护直连规则「${protectedSuffix}」，不受签名补充规则覆盖。`, protectedSuffix)
  }
  // 顺序与 Xray 规则表一致(保护直连之后、签名补充之前):AI 和 GitHub 走专用出站,与其余国外的通用出站分开(CH-1)。
  const dedicatedSuffix = matchedSuffix(host, routes.dedicatedSuffixes ?? [])
  if (dedicatedSuffix !== undefined) {
    return {
      outcome: 'dedicated', reasonCode: 'DEDICATED_TUNNEL_SUFFIX', title: 'AI 与 GitHub 专用通道',
      detail: `匹配专用通道规则「${dedicatedSuffix}」，这类流量走专用出站，与其余国外流量的通用出站分开。`,
      matchedRule: dedicatedSuffix
    }
  }
  const tunnelSuffix = matchedSuffix(host, routes.tunnelSuffixes ?? [])
  if (tunnelSuffix !== undefined) {
    return tunnel('SIGNED_TUNNEL_SUFFIX', '签名配置指定走通道', `匹配已签名配置中的通道补充规则「${tunnelSuffix}」。`, tunnelSuffix)
  }
  const directSuffix = matchedSuffix(host, routes.directSuffixes)
  if (directSuffix !== undefined) {
    return direct('EXPLICIT_DIRECT_SUFFIX', '明确规则直连', `匹配基础分流表或已签名的直连补充规则「${directSuffix}」。`, directSuffix)
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return direct('LOCALHOST', '本机地址直连', '匹配本机地址规则，不经过来信通道。', 'localhost')
  }
  return kernelCheck('XRAY_GEOSITE_OR_DEFAULT', '等待内核判断分流', 'Xray 会先检查国内域名库；未命中才走通用通道。', '')
}

function normalizeHost(value: string): string | undefined {
  const host = value.trim().toLowerCase()
  if (host === '') return undefined
  if (isIP(host)) return host
  if (['/', '?', ':', '#', '@', '[', ']'].some((character) => host.includes(character))) return undefined
  if (host.length > 253 || host === 'localhost') return host === 'localhost' ? host : undefined
  const labels = host.split('.')
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined
  return host
}

// 只认每份 geoip:private 数据都必然包含的段:RFC 1918 三段、回环、链路本地,
// 以及 IPv6 的回环、唯一本地(fc00::/7)与链路本地(fe80::/10)。
// CGNAT(100.64/10)等有争议的段 ⛔ 在这里断言直连——说不准就交给内核判,别猜。
function isPrivateAddress(host: string): boolean {
  if (isIP(host) === 4) {
    const [first, second] = host.split('.').map(Number)
    if (first === 10 || first === 127) return true
    if (first === 172 && second >= 16 && second <= 31) return true
    if (first === 192 && second === 168) return true
    return first === 169 && second === 254
  }
  const value = host.toLowerCase()
  return value === '::1' || /^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value)
}

// 返回真正命中的那一条后缀而不是布尔:客户要看的是「因为哪条规则」,⛔ 只说命中了某一类。
function matchedSuffix(host: string, suffixes: readonly string[]): string | undefined {
  return suffixes.map((raw) => raw.toLowerCase())
    .find((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

function direct(reasonCode: string, title: string, detail: string, matchedRule: string): RouteExplanation {
  return { outcome: 'direct', reasonCode, title, detail, matchedRule }
}

function tunnel(reasonCode: string, title: string, detail: string, matchedRule: string): RouteExplanation {
  return { outcome: 'tunnel', reasonCode, title, detail, matchedRule }
}

function kernelCheck(reasonCode: string, title: string, detail: string, matchedRule: string): RouteExplanation {
  return { outcome: 'kernel-check', reasonCode, title, detail, matchedRule }
}
