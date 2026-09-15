import { deepEqual } from './restore.mjs'
import { autoDetectBitsEqual } from './connection-settings.mjs'

// DefaultConnectionSettings(WPAD 的 blob)按语义位比:所有权/还原判据只看我们动过的 autoDetect 位
// (W2-1,真机 2026-09-14)。Windows 会对代理相关值连带规范化(counter 跳变、DIRECT 位、整份重写),
// 字节比对会把我们自己的写入判成外部改动 → 客户的「自动检测设置」退出时停在关。
// 认不得格式的 blob(semantic = undefined)回落字节比,保守不动。ProxyOverride 仍按集合语义。
export function wininetValuesEqual(left, right, ref) {
  if (ref?.service === 'WinINET' && ref.item === 'DefaultConnectionSettings' &&
      left?.type === 'REG_BINARY' && right?.type === 'REG_BINARY' &&
      typeof left.data === 'string' && typeof right.data === 'string') {
    const semantic = autoDetectBitsEqual(left.data, right.data)
    if (semantic !== undefined) return semantic
  }
  if (ref?.service === 'WinINET' && ref.item === 'ProxyOverride' &&
      left?.type === 'REG_SZ' && right?.type === 'REG_SZ' &&
      typeof left.data === 'string' && typeof right.data === 'string') {
    const entries = (value) => [...new Set(value.split(';').map((item) => item.trim().toLowerCase()).filter(Boolean))].sort()
    return deepEqual(entries(left.data), entries(right.data))
  }
  return deepEqual(left, right)
}

// ProxyServer 有两种写法:`host:port`(所有协议同一代理)或 `http=h:p;https=h:p;socks=h:p`。
// 取 http(或 https)那条当 http 代理;只有 socks 那条就当 socks 代理。
export function parseProxyServer(data) {
  const text = String(data ?? '').trim()
  if (text === '') return undefined
  const entries = text.split(';').map((part) => part.trim()).filter(Boolean)
  const pick = (candidate, kind) => {
    const match = /^(?:[a-z]+:\/\/)?\[?([^\]/:]+)\]?:(\d{1,5})$/i.exec(candidate)
    if (!match) return undefined
    const port = Number(match[2])
    return port > 0 && port <= 65535 ? { kind, host: match[1], port } : undefined
  }
  if (entries.length === 1 && !entries[0].includes('=')) return pick(entries[0], 'http')
  const byScheme = Object.fromEntries(entries.filter((part) => part.includes('=')).map((part) => part.split('=').map((piece) => piece.trim().toLowerCase())))
  return pick(byScheme.http ?? '', 'http') ?? pick(byScheme.https ?? '', 'http') ?? pick(byScheme.socks ?? '', 'socks')
}
