import type { DiagnosticState } from '../network-diagnostics-types'

export type LocalEgressEvidence = {
  readonly platform: 'windows' | 'other'
  readonly sampledAt: number
  readonly interface: 'up' | 'none' | 'unknown'
  readonly ipv4DefaultRoute: 'present' | 'absent' | 'unknown'
  readonly ipv6DefaultRoute: 'present' | 'absent' | 'unknown'
}

const interfaces = new Set(['up', 'none', 'unknown'])
const routes = new Set(['present', 'absent', 'unknown'])

export function unknownLocalEgressEvidence(platform: NodeJS.Platform | 'windows' | 'other', sampledAt: number): LocalEgressEvidence {
  return { platform: platform === 'win32' || platform === 'windows' ? 'windows' : 'other', sampledAt,
    interface: 'unknown', ipv4DefaultRoute: 'unknown', ipv6DefaultRoute: 'unknown' }
}

/** OS 输出在第一道出口归一化；快照及支持包再调用一次，绝不向外透传任意字符串。 */
export function normalizeLocalEgressEvidence(value: unknown): LocalEgressEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const data = value as Record<string, unknown>
  if ((data.platform !== 'windows' && data.platform !== 'other') ||
      !Number.isSafeInteger(data.sampledAt) || !Number.isFinite(new Date(data.sampledAt as number).getTime()) ||
      (data.sampledAt as number) < 0) return undefined
  const fallback = unknownLocalEgressEvidence(data.platform, data.sampledAt as number)
  if (data.platform === 'other') return fallback
  if (!interfaces.has(data.interface as string) || !routes.has(data.ipv4DefaultRoute as string) ||
      !routes.has(data.ipv6DefaultRoute as string)) return fallback
  return { platform: data.platform, sampledAt: data.sampledAt as number,
    interface: data.interface as LocalEgressEvidence['interface'],
    ipv4DefaultRoute: data.ipv4DefaultRoute as LocalEgressEvidence['ipv4DefaultRoute'],
    ipv6DefaultRoute: data.ipv6DefaultRoute as LocalEgressEvidence['ipv6DefaultRoute'] }
}

export type LocalEgressAssessment = 'no-local-egress' | 'path-indicated' | 'unknown'

export function localEgressAssessment(evidence: LocalEgressEvidence, internet: DiagnosticState): LocalEgressAssessment {
  if (evidence.platform !== 'windows') return 'unknown'
  // HTTP 确曾响应时，与“系统无出站路径”的 OS 读数相矛盾，宁可保持未知。
  if (internet === 'unknown' && evidence.interface === 'none' &&
      evidence.ipv4DefaultRoute === 'absent' && evidence.ipv6DefaultRoute === 'absent') return 'no-local-egress'
  if (evidence.interface === 'up' &&
      (evidence.ipv4DefaultRoute === 'present' || evidence.ipv6DefaultRoute === 'present')) return 'path-indicated'
  return 'unknown'
}

export function localEgressDescription(evidence: LocalEgressEvidence, internet: DiagnosticState): { readonly title: string; readonly detail: string } {
  switch (localEgressAssessment(evidence, internet)) {
    case 'no-local-egress': return { title: '本机未发现可用出站路径',
      detail: '本次只读检查同时确认无活动接口、无 IPv4 和 IPv6 默认路由。请先检查电脑的网络连接，再重新诊断。' }
    case 'path-indicated': return { title: '本机有活动接口和默认路由',
      detail: '这只能证明存在出站配置，不能证明 DNS、通道或目标服务可用；请结合其余检查定位。' }
    default: return { title: '本机出站路径暂不能确定',
      detail: '本次系统读数不完整、读数与连通性结果冲突，或当前平台尚不支持此项。请结合其余检查定位。' }
  }
}
