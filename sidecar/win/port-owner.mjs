// 认一认「占着我们入口端口的是谁」(创始人 2026-09-15 修复边界第 1 条)。
//
// 为什么要认:18080 是来信自己的固定入口。它被占,第一嫌疑就是**另一份来信**。
// 原来的做法是「被占就换下一个候选」,于是新来的换个端口继续去写系统代理——
// 两份来信各自监听各自的端口、抢同一份 WinINET,这正是 2026-09-15 那台机器反复横跳的形状。
//
// 边界(硬线):这里**只识别,不执行**。⛔ 因为目录看着像旧版就去运行它里面的命令——
// 那等于拿一个没验证过的路径当可信程序跑。交接只走受控通道,识别的结果只用来决定「说什么话」。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

/** 认定为来信自身的判据:进程可执行文件名。产品名改了这里要跟着改,⛔ 用模糊包含匹配别家程序。 */
export const LAIXIN_PROCESS_NAMES = Object.freeze(['来信AI工具箱统一版', '来信AI工具箱'])

/**
 * 当前本地代理入口由守护 Node relay 监听；旧版入口也可能由随包 xray 占用。
 * 只认主程序名会把旧版自家进程认成「别家程序」并继续抢端口。
 *
 * 判据用**路径结构**,⛔ 只看进程名叫不叫 xray:别家软件也用 xray,认错了会把客户自己的
 * 代理软件说成「另一份来信」。来信的 xray 一定住在 <安装目录>\resources\xray\xray.exe,
 * 且同一个安装目录下有来信主程序——两条同时成立才算。
 */
export function isLaixinXrayPath(path, exists = existsSync) {
  if (typeof path !== 'string') return false
  const match = /^(.*)[\\/]resources[\\/]xray[\\/]xray\.exe$/i.exec(path.trim())
  if (match === null) return false
  return isLaixinInstallDir(match[1], exists)
}

/**
 * 判「这个可执行文件是不是来信」的**主判据**:它所在目录下有没有我们自己的守护脚本。
 *
 * ⛔ 靠进程名匹配产品名:那个名字是中文,跨进程读回来会因控制台代码页变成乱码
 * (2026-09-15 真机实测)。就算编码修对了,名字也可能被改;而 resources\sidecar\win\tunnel-daemon.mjs
 * 是来信独有的结构,别家程序不会有。
 */
export function isLaixinInstallDir(dir, exists = existsSync) {
  if (typeof dir !== 'string' || dir.trim() === '') return false
  return exists(`${dir.trim()}\\resources\\sidecar\\win\\tunnel-daemon.mjs`)
}

/** 从可执行文件路径认来信:取它所在目录再按上面的结构判据看。 */
export function isLaixinExePath(exePath, exists = existsSync) {
  if (typeof exePath !== 'string' || exePath.trim() === '') return false
  const dir = exePath.trim().replace(/[\\/][^\\/]+$/, '')
  return dir !== exePath.trim() && isLaixinInstallDir(dir, exists)
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']
const PS_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 5_000
const AF_INET = 2
const AF_INET6 = 23
const TCP_TABLE_OWNER_PID_LISTENER = 3
const ERROR_INSUFFICIENT_BUFFER = 122
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const ownerCache = new Map()
let defaultNativeTried = false
let defaultNativeOwner

function ownerScript(port) {
  // 一次 PowerShell 拿齐 pid / 进程名 / 路径；成功查明无监听才输出专用标记。
  // ⛔ 用 SilentlyContinue：查询失败与无监听会变成同一个空输出。
  return [
    // 输出必须显式转 UTF-8:PowerShell 默认按控制台代码页(中文机器上是 GBK)写 stdout,
    // 而我们按 utf8 读 —— 产品名与路径里的中文会变成乱码,匹配必然失败
    // (2026-09-15 Windows 真机实测:name 读出来是「????AI??????」,端口认人因此形同虚设)。
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$ErrorActionPreference = 'Stop'",
    `$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq ${String(port)} })`,
    "if ($listeners.Count -eq 0) { 'LAIXIN_NO_LISTENER'; exit 0 }",
    // WinINET 指向 127.0.0.1。::1-only 不能服务这个 IPv4 入口；:: 可能是双栈，
    // 多 PID 也不能凭第一条猜归属。
    "if (@($listeners | Where-Object { [string]$_.LocalAddress -like '*:*' -and $_.LocalAddress -ne '::1' }).Count -gt 0) { 'LAIXIN_ADDRESS_AMBIGUOUS'; exit 0 }",
    "$ipv4 = @($listeners | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' })",
    "if ($ipv4.Count -eq 0) { 'LAIXIN_NO_LISTENER'; exit 0 }",
    "$ids = @($ipv4 | Select-Object -ExpandProperty OwningProcess -Unique)",
    "if ($ids.Count -ne 1) { 'LAIXIN_ADDRESS_AMBIGUOUS'; exit 0 }",
    "$c = $ipv4 | Select-Object -First 1",
    '$p = Get-Process -Id $c.OwningProcess -ErrorAction Stop',
    '"{0}|{1}|{2}" -f $c.OwningProcess, $p.ProcessName, $p.Path'
  ].join('\n')
}

/**
 * 谁在监听这个端口。
 * → { kind: 'laixin' | 'other' | 'none' | 'unknown', pid?, name?, path? }
 *   laixin  = 另一份来信(进程名对得上)。调用方应进「已有另一份来信在运行」的稳定态,⛔ 换端口继续抢。
 *   other   = 别的程序占着。沿用原行为(换下一个候选端口),⛔ 把它说成旧版来信。
 *   none    = 查询成功且确无监听；unknown = 命令不可用/超时/权限/结果不可解析。
 */
export function identifyPortOwnerViaPowerShell(port, { exec = execFileSync, timeoutMs = PS_TIMEOUT_MS } = {}) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return { kind: 'unknown', reason: 'invalid-port' }
  let raw
  try {
    raw = exec('powershell.exe', [...PS_ARGS, ownerScript(port)], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const reason = error?.code === 'ETIMEDOUT' ? 'timeout' : error?.code === 'ENOENT' ? 'command-unavailable'
      : error?.code === 'EACCES' || error?.code === 'EPERM' ? 'permission-denied' : 'query-failed'
    return { kind: 'unknown', reason }
  }
  return parsePortOwner(raw)
}

function localPort(raw) {
  return ((raw & 0xff) << 8) | ((raw >> 8) & 0xff)
}

function readTcpTable(getExtendedTcpTable, family, rowSize) {
  const size = [0]
  const probed = getExtendedTcpTable(null, size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0)
  if (![0, ERROR_INSUFFICIENT_BUFFER].includes(probed) || !Number.isSafeInteger(size[0]) || size[0] < 4) {
    throw new Error('TCP_TABLE_SIZE_FAILED')
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const table = Buffer.alloc(size[0])
    const actual = [table.length]
    const status = getExtendedTcpTable(table, actual, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0)
    if (status === ERROR_INSUFFICIENT_BUFFER && Number.isSafeInteger(actual[0]) && actual[0] > table.length) {
      size[0] = actual[0]
      continue
    }
    if (status !== 0) throw new Error('TCP_TABLE_READ_FAILED')
    const count = table.readUInt32LE(0)
    if (4 + count * rowSize > table.length) throw new Error('TCP_TABLE_TRUNCATED')
    return { table, count }
  }
  throw new Error('TCP_TABLE_CHANGED')
}

function ipv6Loopback(table, offset) {
  for (let index = 0; index < 15; index += 1) if (table[offset + index] !== 0) return false
  return table[offset + 15] === 1
}

/**
 * Windows 端口归属的进程内实现。加载失败返回 undefined，单次系统读取失败由调用方回落 PowerShell。
 * requireImpl/exists 仅用于无 Windows CI 的假 FFI 回归。
 */
export function loadNativePortOwner(requireImpl = createRequire(import.meta.url), exists = existsSync) {
  try {
    const koffi = requireImpl('koffi')
    const iphlpapi = koffi.load('iphlpapi.dll')
    const kernel32 = koffi.load('kernel32.dll')
    const getExtendedTcpTable = iphlpapi.func(
      'int32 __stdcall GetExtendedTcpTable(_Out_ void *pTcpTable, _Inout_ uint32 *pdwSize, bool bOrder, uint32 ulAf, uint32 TableClass, uint32 reserved)')
    const openProcess = kernel32.func(
      'void* __stdcall OpenProcess(uint32 dwDesiredAccess, bool bInheritHandle, uint32 dwProcessId)')
    const queryProcessPath = kernel32.func(
      'bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32 dwFlags, _Out_ uint16 *lpExeName, _Inout_ uint32 *lpdwSize)')
    const closeHandle = kernel32.func('bool __stdcall CloseHandle(void *hObject)')
    return (port) => {
      // MIB_TCP6ROW_OWNER_PID:local address@0、scope@16、port@20，整行 56 字节。
      // 这里按 Windows SDK 结构读取，避免把 scope id 误当端口而漏掉双栈通配监听。
      const ipv6 = readTcpTable(getExtendedTcpTable, AF_INET6, 56)
      for (let index = 0; index < ipv6.count; index += 1) {
        const row = 4 + index * 56
        if (localPort(ipv6.table.readUInt32LE(row + 20)) === port && !ipv6Loopback(ipv6.table, row)) {
          return { kind: 'unknown', reason: 'address-ambiguous' }
        }
      }
      const ipv4 = readTcpTable(getExtendedTcpTable, AF_INET, 24)
      const pids = new Set()
      for (let index = 0; index < ipv4.count; index += 1) {
        const row = 4 + index * 24
        const address = ipv4.table.readUInt32LE(row + 4)
        if (localPort(ipv4.table.readUInt32LE(row + 8)) === port && (address === 0 || address === 0x0100007f)) {
          pids.add(ipv4.table.readUInt32LE(row + 20))
        }
      }
      if (pids.size === 0) return { kind: 'none' }
      if (pids.size !== 1) return { kind: 'unknown', reason: 'address-ambiguous' }
      const [pid] = pids
      const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
      if (handle === null || handle === undefined) throw new Error('PROCESS_OPEN_FAILED')
      try {
        const capacity = 32_768
        const output = Buffer.alloc(capacity * 2)
        const length = [capacity]
        if (!queryProcessPath(handle, 0, output, length) || !Number.isSafeInteger(length[0]) || length[0] <= 0 || length[0] > capacity) {
          throw new Error('PROCESS_PATH_FAILED')
        }
        const path = Buffer.from(output.subarray(0, length[0] * 2)).toString('utf16le')
        const name = path.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')
        return parsePortOwner(`${String(pid)}|${name}|${path}`, exists)
      } finally {
        try { closeHandle(handle) } catch { /* 句柄随进程回收 */ }
      }
    }
  } catch { return undefined }
}

function nativePortOwner() {
  if (!defaultNativeTried) {
    defaultNativeTried = true
    defaultNativeOwner = loadNativePortOwner()
  }
  return defaultNativeOwner
}

export function resetPortOwnerCache() {
  ownerCache.clear()
}

/**
 * 谁在监听这个端口。测试显式注入 exec 时保留原 PowerShell 契约；生产先走原生 API，
 * 绑定不可用或本次原生读取失败才回落 PowerShell。普通探测结果按端口短暂缓存，挡住
 * 重连梯子的查询风暴；恢复所有权判定传 fresh:true，永远重新取证，不能把旧快照带入写回。
 */
export function identifyPortOwner(port, options = {}) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return { kind: 'unknown', reason: 'invalid-port' }
  if (Object.hasOwn(options, 'exec')) return identifyPortOwnerViaPowerShell(port, options)
  const fresh = options.fresh === true
  if (!fresh) {
    const cached = ownerCache.get(port)
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  }
  let result
  try {
    const injected = options.nativeOwner
    result = typeof injected === 'function' ? injected(port) : nativePortOwner()?.(port)
  } catch { /* 回落子进程 */ }
  if (result === undefined) result = identifyPortOwnerViaPowerShell(port, { timeoutMs: options.timeoutMs })
  ownerCache.set(port, { at: Date.now(), value: result })
  return result
}

/** 解析与判定分开,便于用例喂真实输出逐字核对。 */
export function parsePortOwner(raw, exists = existsSync) {
  const line = String(raw ?? '').split(/\r?\n/).map((value) => value.trim()).find((value) => value.length > 0)
  if (line === 'LAIXIN_NO_LISTENER') return { kind: 'none' }
  if (line === 'LAIXIN_ADDRESS_AMBIGUOUS') return { kind: 'unknown', reason: 'address-ambiguous' }
  if (line === undefined) return { kind: 'unknown', reason: 'invalid-result' }
  const [pidText, name = '', path = ''] = line.split('|')
  const pid = Number.parseInt(pidText, 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: 'unknown', reason: 'invalid-result' }
  // 三条任一成立即认定是来信:目录结构(主判据,不依赖名字)、自家 xray、产品名对得上(兜底)。
  const cleanPath = path.trim()
  const isLaixin = isLaixinExePath(cleanPath, exists) || isLaixinXrayPath(cleanPath, exists) ||
    LAIXIN_PROCESS_NAMES.includes(name.trim())
  return { kind: isLaixin ? 'laixin' : 'other', pid, name: name.trim(), path: path.trim() }
}
