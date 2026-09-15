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

/** 认定为来信自身的判据:进程可执行文件名。产品名改了这里要跟着改,⛔ 用模糊包含匹配别家程序。 */
export const LAIXIN_PROCESS_NAMES = Object.freeze(['来信AI工具箱统一版', '来信AI工具箱'])

/**
 * 占着入口端口的**通常不是主程序,而是它起的 xray**(2026-09-15 Windows 真机实测:
 * 中继由 xray 监听,主程序只是它的父进程)。只认主程序名 → 把自己人认成「别家程序」→
 * 换个端口继续抢,端口认人形同虚设。
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

function ownerScript(port) {
  // 一次 PowerShell 拿齐 pid / 进程名 / 路径。取不到就输出空,调用方按 unknown 处理。
  return [
    // 输出必须显式转 UTF-8:PowerShell 默认按控制台代码页(中文机器上是 GBK)写 stdout,
    // 而我们按 utf8 读 —— 产品名与路径里的中文会变成乱码,匹配必然失败
    // (2026-09-15 Windows 真机实测:name 读出来是「????AI??????」,端口认人因此形同虚设)。
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$c = Get-NetTCPConnection -LocalPort ${String(port)} -State Listen | Select-Object -First 1`,
    'if ($null -ne $c) {',
    '  $p = Get-Process -Id $c.OwningProcess',
    '  "{0}|{1}|{2}" -f $c.OwningProcess, $p.ProcessName, $p.Path',
    '}'
  ].join('\n')
}

/**
 * 谁在监听这个端口。
 * → { kind: 'laixin' | 'other' | 'unknown', pid?, name?, path? }
 *   laixin  = 另一份来信(进程名对得上)。调用方应进「已有另一份来信在运行」的稳定态,⛔ 换端口继续抢。
 *   other   = 别的程序占着。沿用原行为(换下一个候选端口),⛔ 把它说成旧版来信。
 *   unknown = 查不出来(命令不可用/超时/权限)。按 other 处理但话要说得谨慎。
 */
export function identifyPortOwner(port, { exec = execFileSync, timeoutMs = 4000 } = {}) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) return { kind: 'unknown' }
  let raw
  try {
    raw = exec('powershell.exe', [...PS_ARGS, ownerScript(port)], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch { return { kind: 'unknown' } }
  return parsePortOwner(raw)
}

/** 解析与判定分开,便于用例喂真实输出逐字核对。 */
export function parsePortOwner(raw, exists = existsSync) {
  const line = String(raw ?? '').split(/\r?\n/).map((value) => value.trim()).find((value) => value.length > 0)
  if (line === undefined) return { kind: 'unknown' }
  const [pidText, name = '', path = ''] = line.split('|')
  const pid = Number.parseInt(pidText, 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: 'unknown' }
  // 三条任一成立即认定是来信:目录结构(主判据,不依赖名字)、自家 xray、产品名对得上(兜底)。
  const cleanPath = path.trim()
  const isLaixin = isLaixinExePath(cleanPath, exists) || isLaixinXrayPath(cleanPath, exists) ||
    LAIXIN_PROCESS_NAMES.includes(name.trim())
  return { kind: isLaixin ? 'laixin' : 'other', pid, name: name.trim(), path: path.trim() }
}
