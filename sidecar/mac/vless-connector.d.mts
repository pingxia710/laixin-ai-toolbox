import type { Connector } from './connectors.mjs'
export interface VlessSpec {
  kind: 'vless-reality'
  node: { host: string; port: number }
  credentialPath: string
  localPort: number
  verifyUrl: string
  verifyFallbackUrl?: string
  timeoutMs?: number
}
export declare function createVlessConnector(spec: VlessSpec): Connector & { xrayOutbound(): Record<string, unknown> }
export declare function verifyThroughProxy(port: number, verifyUrl: string, timeoutMs?: number): Promise<{ exitIp: string }>
export interface ExistingProxy { kind: 'http' | 'socks' | 'pac'; host?: string; port?: number; url?: string; source?: string }
/** 这台电脑不经任何代理能不能出外网。**目前未接进连接流程**——判据未定（拿通用探测点会把「能开网页」误判成「能用 AI」）。 */
/** 「客户真正要用的那些服务」:判断客户本来有没有一条能用的路时探这组,⛔ 用通用探测点。 */
export declare const AI_SERVICE_PROBE_URLS: readonly string[]
export declare function probeDirectReachability(urls?: readonly string[], timeoutMs?: number): Promise<{ direct: true }>
export declare function probeExistingProxy(existing: ExistingProxy, urls?: readonly string[], timeoutMs?: number): Promise<{ url: string }>
/** 甲-4 补强:AI 探测的响应判据(按探测地址的真实响应特征分形)。 */
export declare function aiProbeResponseAcceptable(target: URL, statusCode: number | undefined, headers: Record<string, string | string[] | undefined> | undefined): boolean

export declare function verifyWithFallback(port: number, primary: string, fallback?: string, timeoutMs?: number, probe?: typeof verifyThroughProxy): Promise<{ exitIp: string }>
