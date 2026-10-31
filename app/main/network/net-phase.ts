// N-81:网络阶段分类——业务码 + phase 两维中的 phase 维。只在**有证据**时分类:
// 错误码/错误文案能对上号才给阶段,⛔ 靠猜测。业务码语义与此完全正交,由请求层保持原样。
// 证据表(创始人 2026-10-24 定):
//   dns    ENOTFOUND / EAI_AGAIN / ERR_NAME_NOT_RESOLVED
//   tcp    拒绝/重置/地址不可达/网络变化/连接超时(ETIMEDOUT、UND_ERR_CONNECT_TIMEOUT)
//   tls    证书、SSL、握手错误
//   proxy  代理连接失败、CONNECT 隧道失败、SOCKS 失败
//   backend HTTP 5xx/格式错误/后台明确不可用——由请求层按 HTTP 事实标记,不在本函数
//   timeout 超过预算但无法判断具体阶段(AbortError/TimeoutError 无其他证据)
//   unknown 其余一律 unknown
export type NetworkPhase = 'dns' | 'tcp' | 'tls' | 'proxy' | 'backend' | 'timeout' | 'unknown'

const DNS_EVIDENCE = ['ENOTFOUND', 'EAI_AGAIN', 'ERR_NAME_NOT_RESOLVED']
const TCP_EVIDENCE = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_NETWORK_CHANGED',
  'ERR_INTERNET_DISCONNECTED', 'ERR_ADDRESS_INVALID']
const TLS_EVIDENCE = ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE', 'SELF_SIGNED_CERT_IN_CHAIN']

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    chain.push(current)
    current = (current as Error & { cause?: unknown }).cause
  }
  return chain
}

function evidenceTexts(error: unknown): string[] {
  const texts: string[] = []
  for (const item of causeChain(error)) {
    if (item instanceof Error) {
      texts.push(item.name, item.message)
      const causeCode = (item as Error & { cause?: { code?: unknown } }).cause?.code
      if (typeof causeCode === 'string') texts.push(causeCode)
      const ownCode = (item as Error & { code?: unknown }).code
      if (typeof ownCode === 'string') texts.push(ownCode)
    }
  }
  return texts
}

export function classifyNetworkPhase(error: unknown): NetworkPhase {
  if (error === undefined || error === null) return 'unknown'
  const texts = evidenceTexts(error).map((text) => text.toUpperCase())
  const flat = texts.join(' ')

  if (error instanceof Error && (error.name === 'TimeoutError')) return 'timeout'
  // 代理证据优先于底层 tcp 证据:经由代理时的拒绝/重置说明的是代理链路。
  if (flat.includes('ERR_PROXY_CONNECTION_FAILED') || /PROXY.*(TUNNEL|FAILED|CONNECT)/.test(flat) ||
      /SOCKS.*(FAILED|ERROR)/.test(flat)) return 'proxy'
  const viaProxyMarker = texts.some((text) => text.includes('PROXY')) || texts.some((text) => text.includes('SOCKS'))
  // 证据匹配走子串:既覆盖 cause.code 的精确形,也覆盖 Chromium 的 net::ERR_* 消息形。
  for (const evidence of DNS_EVIDENCE) if (flat.includes(evidence)) return viaProxyMarker ? 'proxy' : 'dns'
  for (const evidence of TCP_EVIDENCE) if (flat.includes(evidence)) return viaProxyMarker ? 'proxy' : 'tcp'
  for (const evidence of TLS_EVIDENCE) if (flat.includes(evidence)) return 'tls'
  if (/ERR_CERT_|ERR_SSL_|ERR_TLS_/.test(flat)) return 'tls'
  if (error instanceof Error && error.name === 'AbortError') return 'timeout'
  return 'unknown'
}
