// 原生内核没有父进程死亡通知。此小进程只负责自己启动的 Xray 的生命周期。
// 停止主通道:bridge 关闭本进程的 stdin 管道,收到 EOF 即停 xray(跨平台可靠;
// Windows 上 SIGTERM 等于 TerminateProcess,清理钩子不会跑,⛔ 作为停止信号依赖)。
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function startXrayRunner(options) {
  const {
    executable, config, parent,
    stdin = process.stdin,
    ppid = process.ppid,
    platform = process.platform,
    spawnImpl = spawn,
    getPpid = () => process.ppid,
    exit = (code) => process.exit(code),
    timers = { setInterval, clearInterval, setTimeout, clearTimeout }
  } = options
  if (!executable || !config || !Number.isSafeInteger(parent) || ppid !== parent) {
    exit(64)
    return { stopped: true }
  }
  const child = spawnImpl(executable, ['run', '-config', config], {
    env: { ...process.env, XRAY_LOCATION_ASSET: dirname(executable) },
    stdio: 'ignore', windowsHide: true
  })
  // xray pid 落盘:bridge 停止兜底与下一次启动的孤儿清扫都按它找内核进程。
  // 记档带启动时刻与映像名:PID 会被系统复用,只凭 pid 强杀可能误杀无关进程。
  const pidPath = `${config}.pid`
  const record = { pid: child.pid, startedAt: Date.now(), image: imageNameOf(executable) }
  try { writeFileSync(pidPath, `${JSON.stringify(record)}\n`, { mode: 0o600 }) } catch { /* 兜底通道缺席时主通道仍在。 */ }
  let stopping = false
  let killTimer
  let pollTimer
  const stop = () => {
    if (stopping) return
    stopping = true
    if (pollTimer !== undefined) timers.clearInterval(pollTimer)
    child.kill('SIGTERM')
    killTimer = timers.setTimeout(() => child.kill('SIGKILL'), 500)
  }
  // 主通道:stdin end/close 任一即停;管道可能已提前关闭,readableEnded 直接近停。
  const onPipeClosed = () => stop()
  stdin.once('end', onPipeClosed)
  stdin.once('close', onPipeClosed)
  stdin.once('error', onPipeClosed)
  if (stdin.readableEnded === true) stop()
  else stdin.resume?.()
  // Mac 补充:父进程消失轮询(Windows 上父死后 ppid 值不变,永不触发,⛔ 空转)。
  if (platform !== 'win32') {
    pollTimer = timers.setInterval(() => {
      if (getPpid() !== parent) stop()
    }, 100)
  }
  child.on('error', () => { process.exitCode = 70 })
  child.on('close', (code) => {
    if (pollTimer !== undefined) timers.clearInterval(pollTimer)
    timers.clearTimeout(killTimer)
    try { rmSync(pidPath, { force: true }) } catch { /* 残留 pid 文件无危害:重启会覆写。 */ }
    exit(stopping ? 0 : (code || 70))
  })
  return { stop, child }
}

const entry = process.argv[1] === undefined ? '' : resolve(process.argv[1])
if (entry !== '' && entry === resolve(dirname(fileURLToPath(import.meta.url)), 'xray-runner.mjs')) {
  const [executable, config, parentText] = process.argv.slice(2)
  startXrayRunner({ executable, config, parent: Number(parentText) })
}

// 映像名按两种分隔符取尾:记档在 Windows 上写、可能在别处读,⛔ 依赖当前平台的 path 语义。
function imageNameOf(executablePath) {
  return String(executablePath).split(/[\\/]/).pop()
}
