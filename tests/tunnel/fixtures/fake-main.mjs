// 假主进程(判据 3①):spawn 守护进程并挂住;自己被 kill -9 时不做任何清理(模拟主进程崩溃)。
// 守护的 stdout/stderr 落到数据目录的 daemon.out.log / daemon.err.log,供证据回读。
import { spawn } from 'node:child_process'
import { appendFileSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const [dataDir, daemonPath, ...daemonArgs] = process.argv.slice(2)
if (dataDir === undefined || daemonPath === undefined) {
  process.stderr.write('用法: fake-main.mjs <dataDir> <daemonPath> [daemonArgs...]\n')
  process.exit(64)
}

const outFd = openSync(join(dataDir, 'daemon.out.log'), 'a')
const errFd = openSync(join(dataDir, 'daemon.err.log'), 'a')
const child = spawn(process.execPath, [daemonPath, ...daemonArgs, '--parent-ipc', '1'], {
  stdio: ['ignore', outFd, errFd, 'ipc'],
  detached: true,
  env: process.env
})
closeSync(outFd)
closeSync(errFd)

child.on('exit', (code) => {
  appendFileSync(join(dataDir, 'daemon.out.log'), `DAEMON_EXITED=${String(code)}\n`)
})
process.stdout.write(`DAEMON_PID=${String(child.pid)}\nFAKE_MAIN_READY\n`)

// 挂住进程(等 kill -9);用单个长超时保持事件循环,⛔ 用 setInterval(eslint 扫描面约定)
setTimeout(() => undefined, 2_147_483_647)
