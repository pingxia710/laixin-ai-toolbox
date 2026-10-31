// N-81/N-79:守护侧网络阶段分类(与 app/main/network/net-phase.ts 同一张证据表,两侧各自持有)。
// 只在有证据时分类;阶段行 phase 与受控码正交,⛔ 取代业务码。
const DNS_EVIDENCE = ['ENOTFOUND', 'EAI_AGAIN', 'ERR_NAME_NOT_RESOLVED']
const TCP_EVIDENCE = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_ADDRESS_UNREACHABLE', 'ERR_NETWORK_CHANGED',
  'ERR_INTERNET_DISCONNECTED', 'ERR_ADDRESS_INVALID']
const TLS_EVIDENCE = ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_SIGNATURE_FAILURE', 'SELF_SIGNED_CERT_IN_CHAIN']
const PHASES = ['dns', 'tcp', 'tls', 'proxy', 'backend', 'timeout', 'unknown']

function evidenceTexts(error) {
  const texts = []
  let current = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    texts.push(current.name, current.message)
    const causeCode = current.cause?.code
    if (typeof causeCode === 'string') texts.push(causeCode)
    if (typeof current.code === 'string') texts.push(current.code)
    current = current.cause
  }
  return texts
}

export function classifyNetworkPhase(error) {
  if (error === undefined || error === null) return 'unknown'
  const texts = evidenceTexts(error).map((text) => String(text).toUpperCase())
  const flat = texts.join(' ')
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  if (flat.includes('ERR_PROXY_CONNECTION_FAILED') || /PROXY.*(TUNNEL|FAILED|CONNECT)/.test(flat) || /SOCKS.*(FAILED|ERROR)/.test(flat)) return 'proxy'
  const viaProxyMarker = texts.some((text) => text.includes('PROXY')) || texts.some((text) => text.includes('SOCKS'))
  for (const evidence of DNS_EVIDENCE) if (flat.includes(evidence)) return viaProxyMarker ? 'proxy' : 'dns'
  for (const evidence of TCP_EVIDENCE) if (flat.includes(evidence)) return viaProxyMarker ? 'proxy' : 'tcp'
  for (const evidence of TLS_EVIDENCE) if (flat.includes(evidence)) return 'tls'
  if (/ERR_CERT_|ERR_SSL_|ERR_TLS_/.test(flat)) return 'tls'
  if (error instanceof Error && error.name === 'AbortError') return 'timeout'
  return 'unknown'
}

export function isNetworkPhase(value) { return typeof value === 'string' && PHASES.includes(value) }
