import { mkdtempSync, readFileSync, renameSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}

export const fakeAdapterPath = pathToFileURL(
  join(__dirname, 'fixtures', 'fake-adapter.mjs')
).href

export function fakeAdapterEnv(storePath: string, failures?: unknown): NodeJS.ProcessEnv {
  return {
    FAKE_ADAPTER_STORE: storePath,
    FAKE_ADAPTER_FAILURES: JSON.stringify(failures ?? { write: [] })
  }
}

export interface FakeStore {
  readonly [key: string]: unknown
}

export function readFakeStore(storePath: string): FakeStore {
  return existsSync(storePath) ? readJsonFile<FakeStore>(storePath) : {}
}

export function readFakeOps(storePath: string): Array<{ op: string; key: string; value: unknown }> {
  const opsPath = `${storePath}.ops.jsonl`
  if (!existsSync(opsPath)) {
    return []
  }
  // append-only 流水:写者(夹具的 appendFileSync)可能正好写到一半,最后一行没有换行就是没写完。
  // append 不截断文件,所以没有 store 那条「先截断后写」的必现窗口;但对半行 JSON.parse 会抛出
  // **一模一样**的 Unexpected end of JSON input——真撞上会被当成同一个 bug 再查一遍。语义上
  // 没写完的那行本来就该当它不存在。
  const lines = readFileSync(opsPath, 'utf8').split('\n')
  if (lines.at(-1) !== '') lines.pop()
  return lines
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { op: string; key: string; value: unknown })
}

// 假上游 SOCKS:只接受并挂住 TCP 连接、数连接数,可整体杀掉(模拟上游断)。
export interface FakeUpstream {
  readonly port: number
  connectionCount(): number
  killAll(): Promise<void>
}

export async function startFakeUpstream(): Promise<FakeUpstream> {
  let count = 0
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    count += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('假上游未能绑定回环')
  }
  return {
    port: address.port,
    connectionCount: () => count,
    killAll: () =>
      new Promise<void>((resolveClose) => {
        for (const socket of sockets) {
          socket.destroy()
        }
        server.close(() => resolveClose())
      })
  }
}

// 意图文件写入(与主进程原子写同形:临时文件 + rename)。
export function writeIntentFile(dataDir: string, intent: unknown): void {
  const path = join(dataDir, 'intent.json')
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(intent)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export function flushMicrotasks(): Promise<void> {
  return new Promise((resolvePromise) => setImmediate(resolvePromise))
}

// 假上游 SOCKS5 服务端:解析握手与 CONNECT,按注入 dial 表转发,记命中(目标主机:端口)。
export interface FakeSocks5 {
  readonly port: number
  hits(): Array<{ host: string; port: number }>
  /** 掐断当前所有已建连接但继续监听:模拟通道中途重连(D3 演练)。 */
  dropAll(): number
  close(): Promise<void>
}

export async function startFakeSocks5Server(dialMap: Readonly<Record<string, [string, number]>>): Promise<FakeSocks5> {
  const hits: Array<{ host: string; port: number }> = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    // 掐断连接(dropAll / close)时对端可能正在写,会抛 ECONNRESET。
    // 这是演练要制造的正常现象,⛔ 让它冒成未捕获异常污染演练结果。
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(socket))
    let phase: 'greeting' | 'request' = 'greeting'
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (phase === 'greeting') {
        if (buffer.length < 2 + (buffer[1] ?? 0)) {
          return
        }
        phase = 'request'
        buffer = buffer.subarray(2 + buffer[1])
        socket.write(Buffer.from([0x05, 0x00]))
        if (buffer.length === 0) {
          return
        }
      }
      // request: ver cmd rsv atyp ...
      if (buffer.length < 7) {
        return
      }
      const atyp = buffer[3]
      let host: string
      let port: number
      if (atyp === 0x01) {
        if (buffer.length < 10) {
          return
        }
        host = [...buffer.subarray(4, 8)].join('.')
        port = buffer.readUInt16BE(8)
      } else {
        const length = buffer[4]
        if (buffer.length < 7 + length) {
          return
        }
        host = buffer.subarray(5, 5 + length).toString('utf8')
        port = buffer.readUInt16BE(5 + length)
      }
      hits.push({ host, port })
      // 握手解析到此结束，后续应用数据交给 pipe，不能再当成 SOCKS 请求。
      socket.removeAllListeners('data')
      socket.pause()
      const target = dialMap[`${host}:${port}`]
      if (target === undefined) {
        socket.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        return
      }
      const remote = connect({ host: target[0], port: target[1] })
      remote.on('error', () => undefined)
      remote.once('connect', () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
        socket.pipe(remote)
        remote.pipe(socket)
        socket.resume()
      })
      socket.once('close', () => remote.destroy())
      remote.once('close', () => socket.destroy())
      remote.once('error', () => {
        socket.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      })
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('假 SOCKS5 未能绑定回环')
  }
  return {
    port: address.port,
    hits: () => [...hits],
    dropAll: () => {
      const count = sockets.size
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      return count
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const socket of sockets) {
          socket.destroy()
        }
        server.close(() => resolveClose())
      })
  }
}

// 假目标 HTTP 服务:返回固定标记,记请求数。
export interface FakeHttpMarker {
  readonly port: number
  requestCount(): number
  close(): Promise<void>
}

export async function startFakeHttpMarker(marker: string): Promise<FakeHttpMarker> {
  let count = 0
  const server = createHttpServer((request, response) => {
    count += 1
    response.setHeader('content-type', 'text/plain')
    response.end(marker)
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('假目标未能绑定回环')
  }
  return {
    port: address.port,
    requestCount: () => count,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
}

// 经 HTTP 代理发绝对路径 GET,返回响应体文本。
export function httpGetViaProxy(proxyPort: number, targetUrl: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host: '127.0.0.1', port: proxyPort })
    let buffer = Buffer.alloc(0)
    socket.on('connect', () => {
      const url = new URL(targetUrl)
      socket.write(`GET ${targetUrl} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
    })
    socket.on('close', () => {
      const text = buffer.toString('latin1')
      const separator = text.indexOf('\r\n\r\n')
      resolvePromise(separator === -1 ? text : text.slice(separator + 4))
    })
    socket.on('error', rejectPromise)
    socket.setTimeout(5_000, () => {
      socket.destroy()
      rejectPromise(new Error('经代理 GET 超时'))
    })
  })
}

// 等一个真实 I/O 条件(如 socket close 传播),超时即失败,⛔ 静默跳过。
export async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (condition()) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor 超时:条件未达成')
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
  }
}

// 可注入时钟(定稿第 2 轮 4:守护用可注入时钟,逻辑测试不等真实秒)。
export class FakeClock {
  private current = 1_000_000
  private sequence = 0
  private timers: Array<{ id: number; at: number; fn: () => void; interval: number | undefined }> = []

  now(): number {
    return this.current
  }

  setTimeout(fn: () => void, delayMs: number): number {
    this.sequence += 1
    this.timers.push({ id: this.sequence, at: this.current + delayMs, fn, interval: undefined })
    return this.sequence
  }

  setInterval(fn: () => void, intervalMs: number): number {
    this.sequence += 1
    this.timers.push({ id: this.sequence, at: this.current + intervalMs, fn, interval: intervalMs })
    return this.sequence
  }

  clearTimer(id: number): void {
    this.timers = this.timers.filter((timer) => timer.id !== id)
  }

  pendingCount(): number {
    return this.timers.length
  }

  advance(ms: number): void {
    const target = this.current + ms
    for (;;) {
      const next = this.timers
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (next === undefined) {
        break
      }
      this.current = next.at
      if (next.interval === undefined) {
        this.timers = this.timers.filter((timer) => timer.id !== next.id)
      } else {
        next.at = this.current + next.interval
      }
      next.fn()
    }
    this.current = target
  }
}

/**
 * 回收测试起的真守护进程。**⛔ 各处各写一遍**——今天有一处漏了 try/catch：SIGTERM 后等 3 秒超时抛异常，
 * 整个 afterEach 中断，**排在后面的进程一个都收不掉**，跑飞成孤儿。那个孤儿占着本机中继的候选端口
 * （18080），害得另一轮全量红成「恢复错了」；更要紧的是形状——它今天带的是假适配器，
 * 哪天有人跑带真适配器的守护测试再跑飞，那就是在客户机上留一个会改系统代理的进程。
 *
 * 正确的回收：先 SIGTERM 给它走完还原，等不到就 SIGKILL，**每个进程独立处理，一个失败不影响后面**。
 * 返回没收掉的 pid（正常应为空数组，用例可据此断言）。
 */
export async function reapDaemons(
  children: readonly { pid?: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(signal?: NodeJS.Signals): boolean }[],
  gentleMs = 3000
): Promise<number[]> {
  const alive = (child: { exitCode: number | null; signalCode: NodeJS.Signals | null }) =>
    child.exitCode === null && child.signalCode === null
  const stubborn: number[] = []
  for (const child of children) {
    if (!alive(child)) continue
    try { child.kill('SIGTERM') } catch { continue }
    try { await waitFor(() => !alive(child), gentleMs) } catch {
      try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
      try { await waitFor(() => !alive(child), 2000) } catch { if (child.pid !== undefined) stubborn.push(child.pid) }
    }
  }
  return stubborn
}
