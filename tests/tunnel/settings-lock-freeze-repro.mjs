// M10 小改的复现与测量(收拢轮-0.5.9候选清单「怎么算修好」):
// 造「持锁方慢恢复 + 等锁方有流量」,量四样——
//   ① 等锁方主线程冻结时长(心跳最大间隔,模型:tunnel-daemon.mjs 唯一主线程);
//   ② 流量文件最大更新间隔 > 10 秒(status-service.ts:231 判不可用,模型:daemon-core.mjs:1683 每 2 秒写一次);
//   ③ 客户流量最长中断(独立发送方看到的回包最大间隔,模型:本地桥数据面);
//   ④ 等锁结果(几轮、每轮等多久、SettingsBusyError 几次;梯式重试照 restoreSettings 的瞬时语义)。
// 用法:node tests/tunnel/settings-lock-freeze-repro.mjs --hold 12000 --label before-12s --out <目录>
// 持锁方与发送方都是子进程;等锁走 sidecar/win/ledger.mjs(生成版,与生产/用例同源)。
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { pathToFileURL } from 'node:url'
import { setInterval, clearInterval, setTimeout } from 'node:timers'
import { SettingsBusyError, withSettingsLock } from '../../sidecar/win/ledger.mjs'

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const HOLD_MS = Number(arg('hold', '12000'))
const LABEL = String(arg('label', 'run'))
const OUT_DIR = String(arg('out', mkdtempSync(join(tmpdir(), 'lock-freeze-'))))
const RETRY_GAP_MS = 3_000 // 梯式重试的轮间隔(模型:退出慢梯的轮间隔,量级一致即可)
const MAX_ROUNDS = 6
const TRAFFIC_PERIOD_MS = 2_000
const STALE_JUDGE_MS = 10_000
const SENDER_MS = Number(arg('sender-ms', '30000'))
const ledgerUrl = pathToFileURL(join(import.meta.dirname, '../../sidecar/win/ledger.mjs')).href

const dataDir = mkdtempSync(join(tmpdir(), 'lock-freeze-data-'))
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'meta.json'), JSON.stringify({ label: LABEL, holdMs: HOLD_MS, dataDir, pid: process.pid, node: process.version }))

// ---- 持锁方:拿到锁写 held 标记,持 HOLD_MS 后放手(模型:旧守护慢恢复在锁内干活)----
const holderScript = `
  import { withSettingsLock } from ${JSON.stringify(ledgerUrl)}
  import { writeFileSync } from 'node:fs'
  withSettingsLock(${JSON.stringify(dataDir)}, () => {
    writeFileSync(${JSON.stringify(join(OUT_DIR, 'held'))}, String(process.pid))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${JSON.stringify(HOLD_MS)})
  }, { owner: 'slow-restore' })
`
const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript], { stdio: 'ignore' })

// ---- 发送方:独立进程,连上本地桥模型,每 25ms 写 16 字节,量回包最大间隔(客户视角的流量中断)----
const senderScript = `
  import { connect } from 'node:net'
  import { readFileSync, writeFileSync, existsSync } from 'node:fs'
  const at = () => Number(process.hrtime.bigint() / 1_000_000n)
  let port
  for (let i = 0; i < 500 && port === undefined; i += 1) {
    try { port = Number(readFileSync(process.env.PORT_FILE, 'utf8')) } catch { /* 还没写出来 */ }
    if (port === undefined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
  }
  const socket = connect(port, '127.0.0.1')
  let connected = false
  let lastArrival = at()
  let maxGap = 0
  let sent = 0
  let echoed = 0
  socket.on('connect', () => { connected = true })
  socket.on('data', (chunk) => {
    echoed += chunk.length
    const now = at()
    const gap = now - lastArrival
    if (gap > maxGap) maxGap = gap
    lastArrival = now
  })
  const sender = setInterval(() => { if (connected) { socket.write('A'.repeat(16)); sent += 16 } }, 25)
  setTimeout(() => {
    clearInterval(sender)
    socket.destroy()
    writeFileSync(process.env.OUT_FILE, JSON.stringify({ sent, echoed, maxEchoGapMs: maxGap }))
    process.exit(0)
  }, Number(process.env.DURATION_MS))
`

// ---- 等锁方主线程模型(本进程):数据面 + 心跳 + 2 秒流量落盘 ----
const bytes = { in: 0, out: 0 }
const connections = []
const server = createServer((socket) => {
  connections.push(socket)
  socket.on('data', (chunk) => { bytes.in += chunk.length; bytes.out += chunk.length; socket.write(chunk) })
  socket.on('error', () => undefined)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
writeFileSync(join(OUT_DIR, 'port'), String(port))

// 心跳:冻结时长 = 心跳最大间隔(5ms 步进,冻结时它被一起冻结)
let lastBeat = Number(process.hrtime.bigint() / 1_000_000n)
let maxFreezeMs = 0
const heartbeat = setInterval(() => {
  const now = Number(process.hrtime.bigint() / 1_000_000n)
  if (now - lastBeat > maxFreezeMs) maxFreezeMs = now - lastBeat
  lastBeat = now
}, 5)

// 流量落盘:每 2 秒写 traffic.json,量最大写入间隔;>10 秒记一次「流量行会被隐藏」(status-service.ts:234 trafficSummary
// 只是不显示流量行,⛔ 据此判守护不可用——2026-09-17 验收勘误,旧字段名 staleJudgedUnavailable 已更名)。
const trafficPath = join(dataDir, 'traffic.json')
let lastTrafficWrite = Date.now()
let maxTrafficGapMs = 0
let hiddenTrafficRows = 0
const trafficTimer = setInterval(() => {
  const now = Date.now()
  const gap = now - lastTrafficWrite
  if (gap > maxTrafficGapMs) maxTrafficGapMs = gap
  if (gap > STALE_JUDGE_MS) hiddenTrafficRows += 1
  lastTrafficWrite = now
  writeFileSync(trafficPath, JSON.stringify({ observedAt: now, uploadBytes: bytes.in, downloadBytes: bytes.out }))
}, TRAFFIC_PERIOD_MS)

// 发送方先流 1.5 秒,证明数据面本来就是活的
const senderChild = spawn(process.execPath, ['--input-type=module', '-e', senderScript], {
  stdio: 'ignore',
  env: { ...process.env, PORT_FILE: join(OUT_DIR, 'port'), OUT_FILE: join(OUT_DIR, 'sender.json'), DURATION_MS: String(SENDER_MS) }
})
await new Promise((resolve) => setTimeout(resolve, 1_500))

// ---- 等锁 + 梯式重试(默认上限,照生产调用形态:不传 timeoutMs)----
for (let i = 0; i < 500 && !existsSync(join(OUT_DIR, 'held')); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
const cpuBefore = process.cpuUsage()
const rounds = []
for (let round = 1; round <= MAX_ROUNDS; round += 1) {
  const startedAt = Date.now()
  try {
    withSettingsLock(dataDir, () => { writeFileSync(join(OUT_DIR, 'acquired'), String(round)) }, { owner: `waiter-repro:r${String(round)}` })
    rounds.push({ round, waitedMs: Date.now() - startedAt, result: 'acquired' })
    break
  } catch (error) {
    if (!(error instanceof SettingsBusyError)) throw error
    rounds.push({ round, waitedMs: Date.now() - startedAt, result: 'busy', holder: error.holder?.owner })
    await new Promise((resolve) => setTimeout(resolve, RETRY_GAP_MS))
  }
}
const cpuDuring = process.cpuUsage(cpuBefore)

// 收尾:再流 1 秒,停表,汇总
await new Promise((resolve) => setTimeout(resolve, 1_000))
clearInterval(heartbeat)
clearInterval(trafficTimer)
server.close()
for (const socket of connections) socket.destroy()

const summary = {
  label: LABEL,
  holdMs: HOLD_MS,
  rounds,
  busyCount: rounds.filter((round) => round.result === 'busy').length,
  maxFreezeMs: Math.round(maxFreezeMs),
  maxTrafficGapMs,
  trafficRowHiddenOver10s: hiddenTrafficRows > 0,
  senderFile: join(OUT_DIR, 'sender.json'),
  cpuWaitUserMs: Math.round((cpuDuring.user) / 1000),
  cpuWaitSysMs: Math.round((cpuDuring.system) / 1000)
}
writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
process.stdout.write(JSON.stringify(summary) + "\n")
const senderDone = await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (existsSync(join(OUT_DIR, 'sender.json'))) { clearInterval(timer); resolve(true) }
  }, 100)
  setTimeout(() => { clearInterval(timer); resolve(false) }, 35_000)
})
if (senderDone) summary.sender = JSON.parse(readFileSync(join(OUT_DIR, 'sender.json'), 'utf8'))
if (holder.exitCode === null) holder.kill('SIGKILL')
if (senderChild.exitCode === null) senderChild.kill('SIGKILL')
writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
rmSync(dataDir, { recursive: true, force: true })
process.stdout.write(JSON.stringify(summary, null, 2))
