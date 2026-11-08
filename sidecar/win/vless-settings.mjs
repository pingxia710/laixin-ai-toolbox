import { isIP } from 'node:net'

export function validNodeHost(host) {
  return typeof host === 'string' && host.length <= 253 && (isIP(host) !== 0 || host.split('.').every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))
}

// 四个必填字段及可选 spiderX；仅支持根路径和 3x-ui 3.7 派生的 15 位十六进制路径。
export function parseVlessCredential(value) {
  const hasSpiderX = value != null && Object.hasOwn(value, 'spiderX')
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['publicKey,serverName,shortId,uuid', 'publicKey,serverName,shortId,spiderX,uuid'].includes(Object.keys(value).sort().join(',')) ||
      typeof value.uuid !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.uuid) ||
      typeof value.publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.publicKey) ||
      Buffer.from(value.publicKey, 'base64url').toString('base64url') !== value.publicKey ||
      typeof value.shortId !== 'string' || !/^(?:[0-9a-f]{2}){1,8}$/i.test(value.shortId) ||
      !validNodeHost(value.serverName) || isIP(value.serverName) !== 0 ||
      (hasSpiderX && (typeof value.spiderX !== 'string' || ![1, 16].includes(value.spiderX.length) || !/^\/(?:[0-9a-f]{15})?$/.test(value.spiderX)))) {
    throw new Error('VLESS_CONFIG_INVALID')
  }
  return { uuid: value.uuid, publicKey: value.publicKey, shortId: value.shortId, serverName: value.serverName,
    ...(hasSpiderX ? { spiderX: value.spiderX } : {}) }
}

export function validVerifyUrl(value) {
  if (typeof value !== 'string' || value.length > 1024) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash &&
      !isProtectedVerifyHost(url.hostname)
  } catch { return false }
}

const LOCAL_VERIFY_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal'])
const PROTECTED_VERIFY_HOSTS = new Set(['deepseek.com', 'deepseek.cn', 'deepseek.ai'])

function canonicalVerifyHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '')
}

function isProtectedVerifyHost(hostname) {
  const host = canonicalVerifyHost(hostname)
  return [...PROTECTED_VERIFY_HOSTS].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

function isPrivateOrLocalIp(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const family = isIP(normalized)
  if (family === 0) return false
  if (family === 4) {
    const octets = normalized.split('.').map(Number)
    const [a, b] = octets
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 ||
      a >= 224 || a === 198 && (b === 18 || b === 19)
  }
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length)
    if (isIP(mapped) === 4) return isPrivateOrLocalIp(mapped)
  }
  const compact = normalized.replace(/:/g, '')
  return normalized === '::1' || normalized === '::' || compact.startsWith('fc') || compact.startsWith('fd') ||
    compact.startsWith('fe8') || compact.startsWith('fe9') || compact.startsWith('fea') || compact.startsWith('feb') ||
    compact.startsWith('ff')
}

/** Production package boundary: public HTTPS probe on the standard TLS port only. */
export function validProductionVerifyUrl(value, options = {}) {
  if (options.allowLocalVerifyUrls === true) return validVerifyUrl(value)
  if (!validVerifyUrl(value)) return false
  const url = new URL(value)
  const host = canonicalVerifyHost(url.hostname)
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || isIP(host) !== 0 || isPrivateOrLocalIp(host)) return false
  if (LOCAL_VERIFY_HOSTS.has(host) || host.endsWith('.localhost') || host === 'localdomain' || host.endsWith('.localdomain') ||
      host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return false
  return true
}

export function validProductionVerifyFallbackUrl(primary, fallback, options = {}) {
  if (options.allowLocalVerifyUrls === true) return validVerifyFallbackUrl(primary, fallback)
  if (!validProductionVerifyUrl(primary) || !validProductionVerifyUrl(fallback)) return false
  return canonicalVerifyHost(new URL(primary).hostname) !== canonicalVerifyHost(new URL(fallback).hostname)
}

export function validVerifyFallbackUrl(primary, fallback) {
  if (!validVerifyUrl(primary) || !validVerifyUrl(fallback)) return false
  const target = new URL(fallback)
  return target.protocol === 'https:' && target.hostname !== new URL(primary).hostname
}

export function buildVlessOutbound(node, credential) {
  const config = parseVlessCredential(credential)
  return {
    tag: 'ssh-socks', protocol: 'vless',
    settings: { vnext: [{ address: node.host, port: node.port, users: [{ id: config.uuid, encryption: 'none', flow: 'xtls-rprx-vision' }] }] },
    streamSettings: { network: 'tcp', security: 'reality', realitySettings: {
      serverName: config.serverName, fingerprint: 'chrome', publicKey: config.publicKey, shortId: config.shortId,
      ...(config.spiderX === undefined ? {} : { spiderX: config.spiderX })
    } }
  }
}
