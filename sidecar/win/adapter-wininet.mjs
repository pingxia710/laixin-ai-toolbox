// Windows WinINET 适配器。只管理当前用户的四项 Internet Settings,绝不写机器级代理。
// 真实注册表写入受加载闸保护;所有自动化测试必须经注入的假适配器。
// 形态照抄 sidecar/mac/adapter-networksetup.mjs 的闸:TOOLBOX_REAL_NETWORK_ADAPTER=1
// 只由 app/main/tunnel/platform/win.ts 在真实启动路径注入;闸被移除 = 测试报红。
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ConnectorError, CONTROL_CODES } from './connectors.mjs'
import { parseProxyServer, wininetValuesEqual } from './wininet-values.mjs'
import { isOurProxy } from './proxy-identity.mjs'
import { autoDetectManagedItem } from './connection-settings.mjs'

if (process.env.TOOLBOX_REAL_NETWORK_ADAPTER !== '1') {
  throw new Error('REAL_ADAPTER_GUARD:真实 WinINET 适配器未获放行(TOOLBOX_REAL_NETWORK_ADAPTER!=1)')
}

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
// 组织策略键:任一项被策略接管,或 ProxySettingsPerUser=0(机器级代理),都算受管理环境。
const POLICY_KEYS = Object.freeze(['HKCU\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  'HKLM\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'])
// WinINET 选项码:INTERNET_OPTION_SETTINGS_CHANGED=39、INTERNET_OPTION_REFRESH=37(与 Clash Verge 的 sysproxy 同一套)。
const INTERNET_OPTION_SETTINGS_CHANGED = 39
const INTERNET_OPTION_REFRESH = 37
const SERVICE = 'WinINET'
// 「自动检测设置」(WPAD)住在子键 Connections 的一份二进制里,⛔ 和上面四项同键。
// 它开着且网络上真有 WPAD 服务器时,浏览器拿到的 PAC **优先于**我们写的手工代理——
// 客户点了连接、我们也确实写进去了,他的流量却没走我们这条路(场景清单 #21,公司网络常见)。
const CONNECTIONS_KEY = `${KEY}\\Connections`
const CONNECTION_ITEM = 'DefaultConnectionSettings'
const ITEMS = Object.freeze(['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL', CONNECTION_ITEM])

/** 这一项住哪个键下。 */
function keyFor(item) { return item === CONNECTION_ITEM ? CONNECTIONS_KEY : KEY }
const LOCAL_BYPASS = Object.freeze(['<local>', 'localhost', '127.*'])
// reg.exe 瞬时失败(杀软短暂锁键等)重试后才能判死刑;间隔 200ms。
// stdio 必须显式给:execFileSync 默认**把子进程 stderr 转发到父进程 stderr**,而守护被计划任务
// 以 2>&1 收进 tunnel-daemon.log —— 于是「系统找不到指定的注册表项或值」这种**预期内**的缺值提示
// (还是 GBK 控制台编码,在日志里是乱码)逐条灌进去,把端口占用、代理争抢这些真正要看的行淹掉
// (2026-09-15 那台 Windows 的日志实测)。stderr 仍然捕获给 isMissingRegistryEntry 判定用,
// ⛔ 再自动转发;真正的异常由代码按受控码记录。
const REG_TRANSIENT_ATTEMPTS = 3
const REG_TRANSIENT_RETRY_MS = 200
// PowerShell 通道超时:5 秒在新装 Windows(Defender 首扫 + 正在下载大文件)上经常不够,冷启动本身就要 2–4 秒。
const POWERSHELL_READ_TIMEOUT_MS = 10_000
const NOTIFY_TIMEOUT_MS = 15_000
const NOTIFY_ATTEMPTS = 2
const NOTIFY_RETRY_MS = 300
// reg.exe 的退出码 1 泛指失败,但两类失败代价不同:「键/值不存在」是稳定结论,重试 3 次
// 纯白等 ≈0.4 秒/项(审计 A4:四项里常有两项不存在);「拒绝访问/键被短暂锁住」才值得重试。
const REG_MISSING_PATTERNS = Object.freeze([
  /unable to find the specified registry key or value/i,
  /cannot find the file specified/i,
  /找不到指定的注册表项或值/,
  /系统找不到指定的文件/
])
// 明说是瞬时错误的文本优先于任何结构推断:重试才是对的处置。
const REG_TRANSIENT_PATTERNS = Object.freeze([
  /access is denied/i,
  /being used by another process/i,
  /拒绝访问/,
  /正由另一(?:个)?进程使用/
])

// 默认同步休眠:Atomics.wait 阻塞当前线程,适配器操作是同步的,⛔ 用异步 setTimeout。
function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 进程内直接调 wininet.dll 的 InternetSetOptionW(照 Clash Verge 的 sysproxy-rs):没有 PowerShell 冷启动、
 * 没有 Add-Type 编译、没有 5 秒超时。随包的 koffi(N-API,Electron 当 node 跑也能加载)不在或加载失败时返回
 * undefined,调用方回落 PowerShell 通道。⛔ 在这里抛:原生通道只是更快的一条路,不是唯一的路。
 */
export function loadNativeNotifier(requireImpl = createRequire(import.meta.url)) {
  try {
    const koffi = requireImpl('koffi')
    const wininet = koffi.load('wininet.dll')
    const setOption = wininet.func('bool __stdcall InternetSetOptionW(void *hInternet, uint32 dwOption, void *lpBuffer, uint32 dwBufferLength)')
    return () => {
      for (const option of [INTERNET_OPTION_SETTINGS_CHANGED, INTERNET_OPTION_REFRESH]) {
        if (!setOption(null, option, null, 0)) throw new Error(`InternetSetOptionW(${String(option)}) failed`)
      }
    }
  } catch { return undefined }
}

export function createAdapter(options = {}) {
  // 注入点(仅测试):execFile 换假命令执行,sleep 换空操作,nativeNotify 换假原生通知;真实启动路径三者缺省。
  const exec = options.execFile ?? execFileSync
  const sleep = options.sleep ?? defaultSleep
  const nativeNotify = Object.hasOwn(options, 'nativeNotify') ? options.nativeNotify : loadNativeNotifier()
  return {
    valuesEqual: wininetValuesEqual,
    preserveExternalChanges: (ref) => ref.service === SERVICE && ITEMS.includes(ref.item),
    reapplyOnChange: (ref) => ref.service === SERVICE && ITEMS.includes(ref.item),
    preflight() {
      if (hasManagedPolicy()) {
        throw new ConnectorError(CONTROL_CODES.managedPolicy, '系统代理受组织策略管理')
      }
      // 客户主动连接即使用来信网络。旧代理/PAC 由写前账本保存,退出时恢复。
    },
    // 电脑上别的代理(不是我们的)当前开着吗:守护据此决定「能出外网就复用」还是接管。PAC 也报,守护按不可判定处理。
    existingProxy(ours) {
      const pac = read({ service: SERVICE, item: 'AutoConfigURL' })
      if (pac !== null && pac.data !== '') return { kind: 'pac', url: pac.data, source: 'WinINET/AutoConfigURL' }
      const enabled = read({ service: SERVICE, item: 'ProxyEnable' })
      if (enabled?.data !== '1') return undefined
      const server = read({ service: SERVICE, item: 'ProxyServer' })
      const parsed = parseProxyServer(server?.data ?? '')
      if (parsed === undefined) return undefined
      const isOurs = isOurProxy(parsed, ours)
      return isOurs ? undefined : { ...parsed, source: 'WinINET/ProxyServer' }
    },
    managedItems(proxy) {
      const override = read({ service: SERVICE, item: 'ProxyOverride' })
      // 顺序即写入顺序:先 Server 后 Enable,⛔ 反过来(Enable=1 先落时,窗口期系统代理
      // 指向旧值,客户流量瞬间走丢)。恢复按账本逆序:Enable 先归零,原 Server 后回填。
      return [
        { ref: { service: SERVICE, item: 'ProxyServer' }, value: registryValue('REG_SZ', localProxyValue(proxy)) },
        { ref: { service: SERVICE, item: 'ProxyEnable' }, value: registryValue('REG_DWORD', '1') },
        {
          ref: { service: SERVICE, item: 'ProxyOverride' },
          value: registryValue('REG_SZ', mergeProxyOverride(override?.data ?? ''))
        },
        { ref: { service: SERVICE, item: 'AutoConfigURL' }, value: null },
        ...(autoDetectItem() ?? [])
      ]
    },
    read,
    write,
    broadcastSettingsChanged
  }

  /**
   * 要不要把「自动检测设置」纳入受管项。三种情况一律返回 undefined（= 原样不动，回落到今天的行为）:
   *  · 读不到那份设置(没有这个值 / 读失败)
   *  · 认不得这份二进制的格式(结构没有微软文档,位置是从第三方实现反推的——没把握就不动)
   *  · 它本来就关着(⛔ 无谓地写一次、无谓地记一笔账)
   * 只有「确实开着、而且格式认得」才关掉它,并且**整份 blob 进账本**,还原走账本既有语义。
   */
  function autoDetectItem() {
    let current
    try { current = read({ service: SERVICE, item: CONNECTION_ITEM }) } catch { return undefined }
    const item = autoDetectManagedItem(current, { service: SERVICE, item: CONNECTION_ITEM })
    return item === undefined ? undefined : [item]
  }

  function read(ref) {
    if (ref.service !== SERVICE || !ITEMS.includes(ref.item)) {
      throw new Error(`WININET_ITEM_INVALID:${ref.service}/${ref.item}`)
    }
    let output
    // 四项一律先走 reg.exe(几十毫秒、无编译):守护每 30 秒逐项读一次,PowerShell 冷启动 + Add-Type 编译
    // 动辄几秒、还要过杀软,曾是 Windows 上「系统设置暂不可达」抖动的稳定来源(创始人 09-13 真机断网链之一)。
    // 值不存在是稳定结论,直接 null;只有瞬时错误、解析不出、或值含非 ASCII(reg.exe 输出走控制台代码页,
    // 非 ASCII 会被改写)才回落 .NET/ps1 通道取精确值。
    try { output = run('reg.exe', ['query', keyFor(ref.item), '/v', ref.item], isMissingRegistryEntry) } catch (error) {
      if (error?.permanentFailure === true) return null
      return registryCommand({ operation: 'read', item: ref.item })
    }
    const match = output.match(/\s+(REG_[A-Z0-9_]+)[ \t]*(.*)$/im)
    if (match === null) throw new ConnectorError(CONTROL_CODES.settingsTransient, 'WinINET 读数暂时无法解析')
    const data = match[2].replace(/\r$/, '')
    if (match[1] === 'REG_DWORD' || match[1] === 'REG_BINARY') return registryValue(match[1], data)
    if (!['REG_SZ', 'REG_EXPAND_SZ'].includes(match[1]) || !/^[\x20-\x7e]*$/.test(data)) return registryCommand({ operation: 'read', item: ref.item })
    return registryValue(match[1], data)
  }

  function write(ref, value) {
    if (ref.service !== SERVICE || !ITEMS.includes(ref.item)) {
      throw new Error(`WININET_ITEM_INVALID:${ref.service}/${ref.item}`)
    }
    try {
      if (value === null) {
        if (read(ref) !== null) run('reg.exe', ['delete', keyFor(ref.item), '/v', ref.item, '/f'])
        return
      }
      if (!isRegistryValue(value)) {
        throw new Error(`WININET_VALUE_INVALID:${ref.item}`)
      }
      run('reg.exe', ['add', keyFor(ref.item), '/v', ref.item, '/t', value.type, '/d', value.data, '/f'])
    } catch (error) {
      if (error instanceof ConnectorError) {
        throw error
      }
      throw new ConnectorError(CONTROL_CODES.settingsTransient, `WinINET 写入暂时失败:${ref.item}`)
    }
  }

  function broadcastSettingsChanged() {
    // 首选进程内原生调用(毫秒级、无子进程);原生通道不在或本次失败,再走 PowerShell 通道并重试一次。
    // 调用方(restore.mjs)已不把通知失败当恢复失败,这里 ⛔ 因为通知把已写回的设置说成没恢复。
    if (typeof nativeNotify === 'function') {
      try { nativeNotify(); return } catch { /* 回落 PowerShell */ }
    }
    for (let attempt = 1; ; attempt += 1) {
      try { registryCommand({ operation: 'notify' }); return } catch (error) {
        if (attempt >= NOTIFY_ATTEMPTS) throw new ConnectorError(CONTROL_CODES.settingsTransient, 'WinINET 设置通知暂时失败')
        sleep(NOTIFY_RETRY_MS)
      }
    }
  }

  // 组织策略探测先走 reg.exe(几十毫秒):策略键不存在 = 未受管;键在且含四项之一或 ProxySettingsPerUser=0 = 受管;
  // reg.exe 出瞬时错误才回落 PowerShell 通道。
  function hasManagedPolicy() {
    let transient = false
    for (const key of POLICY_KEYS) {
      let output
      try { output = run('reg.exe', ['query', key], isMissingRegistryEntry) } catch (error) {
        if (error?.permanentFailure === true) continue
        transient = true
        continue
      }
      if (ITEMS.some((item) => new RegExp(`^\\s+${item}\\s+REG_`, 'im').test(output))) return true
      const perUser = output.match(/^\s+ProxySettingsPerUser\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)/im)
      if (perUser !== null && Number(perUser[1]) === 0) return true
    }
    if (transient) return registryCommand({ operation: 'policy' })
    return false
  }

  function run(command, args, isPermanentFailure) {
    let lastError
    for (let attempt = 1; attempt <= REG_TRANSIENT_ATTEMPTS; attempt += 1) {
      try {
        return exec(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        lastError = error
        // 判定结果挂在错误上:调用方据此区分「值不存在」(稳定结论)与瞬时失败,⛔ 再探一次父键。
        if (isPermanentFailure?.(error) === true) { try { error.permanentFailure = true } catch { /* 非对象错误 */ } break }
        if (attempt < REG_TRANSIENT_ATTEMPTS) sleep(REG_TRANSIENT_RETRY_MS)
      }
    }
    throw lastError
  }

  // 「这个值不存在」与「这次读失败了」的区分:先看 reg.exe 的输出文本(英文/中文);
  // 文本被系统语言或编码打乱时按结构判——父键读得通,就说明只是这个值不存在。
  function isMissingRegistryEntry(error) {
    const text = `${textOf(error?.stderr)}\n${textOf(error?.stdout)}`
    if (REG_TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) return false
    if (REG_MISSING_PATTERNS.some((pattern) => pattern.test(text))) return true
    try {
      exec('reg.exe', ['query', KEY], { encoding: 'utf8', windowsHide: true, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] })
      return true
    } catch { return false }
  }

  function registryCommand(request) {
    try {
      // 通知要过 Add-Type(首次编译慢,之后走缓存的程序集);读数走 .NET 反射;两者都给足冷启动时间。
      const output = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', fileURLToPath(new URL('./wininet-settings.ps1', import.meta.url))], {
        input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        timeout: request.operation === 'notify' ? NOTIFY_TIMEOUT_MS : POWERSHELL_READ_TIMEOUT_MS
      })
      const result = JSON.parse(output.replace(/^\uFEFF/, '').trim())
      if (request.operation === 'notify' && result !== true) throw new Error('invalid notification response')
      if (request.operation === 'policy' && typeof result !== 'boolean') throw new Error('invalid policy response')
      if (request.operation === 'read' && result !== null) {
        if (!isRegistryValue(result)) throw new Error('invalid registry response')
        return registryValue(result.type, result.data)
      }
      return result
    } catch { throw new ConnectorError(CONTROL_CODES.settingsTransient, '系统代理设置读取或通知暂时失败,将自动重试') }
  }
}

function localProxyValue(proxy) {
  return `127.0.0.1:${String(proxy.port)}`
}


// ProxyOverride 合并 ⛔ 覆盖:客户原有条目逐字保留,只追加本产品的本地回环豁免。
export function mergeProxyOverride(existing) {
  const seen = new Set()
  const entries = []
  for (const value of [...existing.split(';'), ...LOCAL_BYPASS]) {
    const trimmed = value.trim()
    const key = trimmed.toLowerCase()
    if (trimmed !== '' && !seen.has(key)) {
      seen.add(key)
      entries.push(trimmed)
    }
  }
  return entries.join(';')
}

function registryValue(type, data) {
  if (type === 'REG_DWORD') {
    if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(data) || Number(data) > 0xffffffff) throw new Error('WININET_DWORD_INVALID')
    return { type, data: String(Number(data)) }
  }
  if (type === 'REG_BINARY') {
    // reg.exe 的十六进制串。⛔ 放过奇数长度或非十六进制:那写回去就是一份坏掉的连接设置。
    if (!/^[0-9A-Fa-f]*$/.test(data) || data.length % 2 !== 0) throw new Error('WININET_BINARY_INVALID')
    return { type, data: data.toUpperCase() }
  }
  if (!['REG_SZ', 'REG_EXPAND_SZ'].includes(type)) throw new Error('WININET_TYPE_INVALID')
  return { type, data }
}

function isRegistryValue(value) {
  return typeof value === 'object' && value !== null && typeof value.type === 'string' && typeof value.data === 'string'
}

function textOf(value) {
  return value === undefined || value === null ? '' : String(value)
}

