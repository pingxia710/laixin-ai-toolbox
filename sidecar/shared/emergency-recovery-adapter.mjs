// 启动期适配器依赖损坏时的最小恢复通道。
// ⛔ 不导入任何项目模块：它的存在就是为了在普通 adapter 的传递依赖缺失时仍能把已应用设置还回。
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const WININET_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const WININET_CONNECTIONS_KEY = `${WININET_KEY}\\Connections`
const WINDOWS_ITEMS = new Set(['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL', 'DefaultConnectionSettings'])
const MAC_ITEMS = Object.freeze({
  'web-proxy': ['-getwebproxy', '-setwebproxy', '-setwebproxystate'],
  'secure-web-proxy': ['-getsecurewebproxy', '-setsecurewebproxy', '-setsecurewebproxystate'],
  'socks-proxy': ['-getsocksfirewallproxy', '-setsocksfirewallproxy', '-setsocksfirewallproxystate']
})
const EMERGENCY_COMMAND_TIMEOUT_MS = 5_000

function boundedExec(exec, command, args, options = {}) {
  return exec(command, args, { ...options, timeout: EMERGENCY_COMMAND_TIMEOUT_MS })
}

function jsonEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right) }

function autoDetectBit(hex) {
  const text = String(hex ?? '').replace(/\s+/g, '')
  if (text.length < 24 || text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text)) return undefined
  const bytes = Uint8Array.from({ length: text.length / 2 }, (_, index) => Number.parseInt(text.slice(index * 2, index * 2 + 2), 16))
  const view = new DataView(bytes.buffer)
  const version = view.getUint32(0, true)
  const flags = view.getUint32(8, true)
  if (version < 0x20 || version > 0xff || flags > 0xff) return undefined
  return (flags & 8) !== 0
}

function registryValuesEqual(left, right) {
  if (left?.type !== right?.type) return false
  if (left?.type === 'REG_DWORD') {
    const l = Number(String(left.data).trim())
    const r = Number(String(right.data).trim())
    return Number.isSafeInteger(l) && Number.isSafeInteger(r) && l === r
  }
  if (left?.type === 'REG_BINARY') {
    const l = autoDetectBit(left.data)
    const r = autoDetectBit(right.data)
    if (l !== undefined && r !== undefined) return l === r
    return String(left.data).replace(/\s+/g, '').toUpperCase() === String(right.data).replace(/\s+/g, '').toUpperCase()
  }
  return jsonEqual(left, right)
}

function loadWindowsNotifier() {
  try {
    const koffi = createRequire(import.meta.url)('koffi')
    const wininet = koffi.load('wininet.dll')
    const setOption = wininet.func('bool __stdcall InternetSetOptionW(void *hInternet, uint32 dwOption, void *lpBuffer, uint32 dwBufferLength)')
    return () => {
      for (const option of [39, 37]) {
        if (!setOption(null, option, null, 0)) throw new Error(`InternetSetOptionW(${String(option)}) failed`)
      }
    }
  } catch { return undefined }
}

function proxyEndpoints(data) {
  const text = String(data ?? '').trim()
  if (text === '') return []
  const parts = text.split(';').map((part) => part.trim()).filter(Boolean)
  const parse = (candidate) => {
    const match = /^(?:[a-z]+:\/\/)?(\[[^\]]+\]|[^:]+):(\d{1,5})$/i.exec(candidate.trim())
    if (match === null) return undefined
    const port = Number(match[2])
    const host = match[1].replace(/^\[|\]$/g, '')
    return port > 0 && port <= 65535 && host !== '' ? { host, port } : undefined
  }
  const candidates = parts.length === 1 && !parts[0].includes('=')
    ? parts
    : parts.map((part) => {
      const separator = part.indexOf('=')
      return separator < 0 ? '' : part.slice(separator + 1).trim()
    })
  const parsed = candidates.map(parse)
  if (parsed.some((endpoint) => endpoint === undefined)) throw new Error('EMERGENCY_PROXY_SERVER_INVALID')
  return parsed
}

function windowsAdapter(exec, acquireWriteRight, identifyPortOwner, notify) {
  const run = (command, args, options) => boundedExec(exec, command, args, options)
  const keyFor = (item) => item === 'DefaultConnectionSettings' ? WININET_CONNECTIONS_KEY : WININET_KEY
  const read = (ref) => {
    if (!WINDOWS_ITEMS.has(ref?.item) || ref?.service !== 'WinINET') throw new Error('EMERGENCY_REF_INVALID')
    let output
    try {
      output = String(run('reg.exe', ['query', keyFor(ref.item), '/v', ref.item], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }))
    } catch (error) {
      const text = `${String(error?.stdout ?? '')}\n${String(error?.stderr ?? '')}`
      if (/cannot find|找不到指定的注册表项或值|file specified/i.test(text)) return null
      throw error
    }
    const line = output.split(/\r?\n/).find((candidate) => new RegExp(`^\\s*${ref.item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(REG_\\w+)\\s+(.+?)\\s*$`, 'i').test(candidate))
    if (line === undefined) return null
    const match = /^\s*\S+\s+(REG_\w+)\s+(.+?)\s*$/.exec(line)
    if (match === null) return null
    const type = match[1].toUpperCase()
    const data = type === 'REG_BINARY' ? match[2].replace(/\s+/g, '').toUpperCase()
      : type === 'REG_DWORD' ? String(Number(match[2])) : match[2]
    return { type, data }
  }
  const write = (ref, value) => {
    if (value === null) {
      try { run('reg.exe', ['delete', keyFor(ref.item), '/v', ref.item, '/f'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) } catch { /* 缺值已是目标 */ }
      return
    }
    if (value?.type !== 'REG_SZ' && value?.type !== 'REG_EXPAND_SZ' && value?.type !== 'REG_DWORD' && value?.type !== 'REG_BINARY') {
      throw new Error('EMERGENCY_REG_VALUE_INVALID')
    }
    run('reg.exe', ['add', keyFor(ref.item), '/v', ref.item, '/t', value.type, '/d', String(value.data), '/f'], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
  }
  return {
    managedItems: () => [], read, write, valuesEqual: registryValuesEqual,
    restoredValueMatches: (current, original) => registryValuesEqual(current, original),
    acquireWriteRight,
    preserveExternalChanges: () => true, identifyPortOwner,
    readProxyEndpoints: () => {
      const enabled = read({ service: 'WinINET', item: 'ProxyEnable' })
      const server = read({ service: 'WinINET', item: 'ProxyServer' })
      if (String(enabled?.data) !== '1') return []
      return proxyEndpoints(server?.data)
    },
    broadcastSettingsChanged: () => {
      if (typeof notify !== 'function') throw new Error('EMERGENCY_NOTIFY_UNAVAILABLE')
      notify()
    }
  }
}

function macAdapter(exec, acquireWriteRight, identifyPortOwner) {
  const run = (command, args, options) => boundedExec(exec, command, args, options)
  const services = () => String(run('networksetup', ['-listallnetworkservices'], { encoding: 'utf8' }))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^An asterisk \(\*\)/i.test(line) && !line.startsWith('*'))
  const read = (ref) => {
    if (ref?.service === undefined || ref?.item === 'auto-proxy') {
      if (ref?.item !== 'auto-proxy') throw new Error('EMERGENCY_REF_INVALID')
      const output = String(run('networksetup', ['-getautoproxyurl', ref.service], { encoding: 'utf8' }))
      const enabled = /Enabled:\s*Yes/i.test(output)
      const url = /^URL:\s*(.*)$/im.exec(output)?.[1]?.trim() ?? ''
      return { enabled, url }
    }
    const shape = MAC_ITEMS[ref.item]
    if (shape === undefined) throw new Error('EMERGENCY_REF_INVALID')
    const output = String(run('networksetup', [shape[0], ref.service], { encoding: 'utf8' }))
    const enabled = /Enabled:\s*Yes/i.test(output)
    const host = /^Server:\s*(.*)$/im.exec(output)?.[1]?.trim() ?? ''
    const port = Number(/^Port:\s*(\d+)$/im.exec(output)?.[1] ?? 0)
    return { enabled, host, port }
  }
  const write = (ref, value) => {
    if (ref.item === 'auto-proxy') {
      const args = value?.enabled ? ['-setautoproxyurl', ref.service, value.url] : ['-setautoproxystate', ref.service, 'off']
      run('networksetup', args, { encoding: 'utf8' }); return
    }
    const shape = MAC_ITEMS[ref.item]
    if (shape === undefined) throw new Error('EMERGENCY_REF_INVALID')
    if (value?.enabled) run('networksetup', [shape[1], ref.service, value.host, String(value.port)], { encoding: 'utf8' })
    run('networksetup', [shape[2], ref.service, value?.enabled ? 'on' : 'off'], { encoding: 'utf8' })
  }
  return {
    managedItems: () => [], read, write, valuesEqual: jsonEqual,
    acquireWriteRight,
    restoredValueMatches: (current, original, written) => jsonEqual(current, original) ||
      original?.enabled === false && original.host === '' && original.port === 0 && current?.enabled === false &&
      ((current.host === '' && current.port === 0) || (current.host === written?.host && current.port === written?.port)),
    preserveExternalChanges: () => true, identifyPortOwner,
    readProxyEndpoints: () => services().flatMap((service) => Object.keys(MAC_ITEMS).flatMap((item) => {
      const value = read({ service, item })
      if (value?.enabled === true && (value.host === '' || !Number.isInteger(value.port) || value.port <= 0 || value.port > 65535)) {
        throw new Error('EMERGENCY_PROXY_SERVER_INVALID')
      }
      return value?.enabled === true ? [{ host: value.host, port: value.port }] : []
    })),
    broadcastSettingsChanged: () => undefined
  }
}

export async function createEmergencyRecoveryAdapter({ platform = process.platform, exec = execFileSync } = {}) {
  let acquireWriteRight
  let identifyPortOwner
  try {
    const module = platform === 'win32'
      ? await import('../win/wininet-write-right.mjs')
      : platform === 'darwin' ? await import('../mac/macos-write-right.mjs') : undefined
    acquireWriteRight = module?.acquireWriteRight
    const owner = platform === 'win32'
      ? await import('../win/port-owner.mjs')
      : platform === 'darwin' ? await import('../mac/port-owner.mjs') : undefined
    identifyPortOwner = owner?.identifyPortOwner
  } catch { acquireWriteRight = undefined; identifyPortOwner = undefined }
  if (typeof acquireWriteRight !== 'function') throw new Error('EMERGENCY_WRITE_RIGHT_UNAVAILABLE')
  if (typeof identifyPortOwner !== 'function') throw new Error('EMERGENCY_PORT_OWNER_UNAVAILABLE')
  if (platform === 'win32') return windowsAdapter(exec, acquireWriteRight, identifyPortOwner, loadWindowsNotifier())
  if (platform === 'darwin') return macAdapter(exec, acquireWriteRight, identifyPortOwner)
  throw new Error('EMERGENCY_PLATFORM_UNSUPPORTED')
}
