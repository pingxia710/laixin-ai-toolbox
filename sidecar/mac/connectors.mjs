// 连接器(定稿第 2 轮 2 / 第 4 轮定稿 10):
// - ssh-socks:一人一包受限 SSH 用户 `ssh -N -D`,StrictHostKeyChecking=yes + 批次内
//   known_hosts ⇒ 主机指纹连接时强制核验,不符即拒(节点身份不符),⛔ 关闭校验。
// - loopback-probe:逻辑测试用的本地回环假 SOCKS 连接器,只连 127.0.0.1。
// 错误统一分类为八类受控码:端口占用 / 节点身份不符 / 授权失效 / 配额或授权问题 / 上游不可达 /
// 已有代理控制 / 受管理环境 / 组件缺失。后三类与 Windows 侧取值逐字相同——共享的 daemon-core
// 致命码表直接引用它们,mac 这边缺一个就等于往致命码表里塞 undefined。
import { connect } from 'node:net'
import { spawn as defaultSpawn } from 'node:child_process'
import { socks5Connect } from './socks5.mjs'

export const CONTROL_CODES = Object.freeze({
  portBusy: '端口占用',
  hostKeyMismatch: '节点身份不符',
  authFailed: '授权失效',
  quotaOrAuth: '配额或授权问题',
  upstreamUnreachable: '上游不可达',
  probeUnavailable: 'TUNNEL_PROBE_UNAVAILABLE',
  proxyConflict: '已有代理控制',
  managedPolicy: '受管理环境',
  componentMissing: '组件缺失'
})

export class ConnectorError extends Error {
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}:${detail}`)
    this.name = 'ConnectorError'
    this.code = code
  }
}

export function createLoopbackProbeConnector(spec) {
  if (spec.host !== '127.0.0.1' && spec.host !== '::1') {
    throw new ConnectorError(CONTROL_CODES.upstreamUnreachable, `loopback-probe 只接受回环地址,收到 ${spec.host}`)
  }
  let socket
  let lostCallback
  let stopped = false
  return {
    kind: 'loopback-probe',
    localProxyPort: () => spec.port,
    onLost(callback) {
      lostCallback = callback
    },
    start() {
      return new Promise((resolvePromise, rejectPromise) => {
        stopped = false
        const candidate = connect({ host: spec.host, port: spec.port })
        const timer = setTimeout(() => {
          candidate.destroy()
          rejectPromise(new ConnectorError(CONTROL_CODES.upstreamUnreachable, '回环探测超时'))
        }, spec.timeoutMs ?? 5_000)
        candidate.once('error', (error) => {
          clearTimeout(timer)
          rejectPromise(new ConnectorError(CONTROL_CODES.upstreamUnreachable, error.message))
        })
        candidate.once('connect', () => {
          clearTimeout(timer)
          socket = candidate
          socket.on('close', () => {
            if (!stopped && lostCallback !== undefined) {
              lostCallback(new ConnectorError(CONTROL_CODES.upstreamUnreachable, '回环连接断开'))
            }
          })
          resolvePromise()
        })
      })
    },
    async verify() {
      if (socket === undefined || socket.destroyed) {
        throw new ConnectorError(CONTROL_CODES.upstreamUnreachable, '回环探测未连接')
      }
      return { exitIp: spec.exitIp }
    },
    stop() {
      stopped = true
      socket?.destroy()
      socket = undefined
    }
  }
}

export function createSshSocksConnector(spec, injected = {}) {
  const spawnImpl = injected.spawn ?? defaultSpawn
  let child
  let lostCallback
  let stopped = false
  let stderrTail = ''

  return {
    kind: 'ssh-socks',
    localProxyPort: () => spec.localPort,
    onLost(callback) {
      lostCallback = callback
    },
    async start() {
      stopped = false
      stderrTail = ''
      const args = [
        '-N', '-T',
        '-D', `127.0.0.1:${spec.localPort}`,
        '-p', String(spec.node.port),
        '-i', spec.keyPath,
        '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${spec.knownHostsPath}`,
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=2',
        `${spec.node.sshUser}@${spec.node.host}`
      ]
      child = spawnImpl('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.on('data', (chunk) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4000)
      })
      let exitFailure
      // spawn 本身失败(ssh 不可执行/被删/没有执行权限)只发 'error',不发 'exit'。
      // ⛔ 不监听:它会冒成未捕获异常 → 守护 exit(70) → 状态层「守护异常退出」+ 三次重启,
      // 客户从文案里根本看不出是缺组件,还要白等三轮恢复系统代理的抖动。
      child.once('error', (error) => {
        exitFailure = classifySpawnError(error)
        if (!stopped && lostCallback !== undefined) {
          lostCallback(exitFailure)
        }
      })
      child.on('exit', (code) => {
        // 已有 spawn 失败结论时不覆盖:那一条比退出码更准。
        exitFailure ??= classifySshExit(code, stderrTail)
        if (!stopped && lostCallback !== undefined) {
          lostCallback(exitFailure)
        }
      })
      await waitForLocalSocks(spec.localPort, spec.readyTimeoutMs ?? 15_000, () => exitFailure)
    },
    async verify() {
      const url = new URL(spec.verifyUrl)
      const socket = await socks5Connect({
        host: '127.0.0.1',
        port: spec.localPort,
        targetHost: url.hostname,
        targetPort: url.port === '' ? 80 : Number.parseInt(url.port, 10),
        timeoutMs: spec.timeoutMs ?? 10_000
      })
      try {
        return { exitIp: await httpGetBody(socket, url) }
      } finally {
        socket.destroy()
      }
    },
    async stop() {
      stopped = true
      if (child !== undefined && child.exitCode === null) {
        child.kill('SIGTERM')
      }
      child = undefined
    }
  }
}

async function waitForLocalSocks(port, timeoutMs, failureOf) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const failure = failureOf()
    if (failure) throw failure
    const reachable = await probeTcp('127.0.0.1', port)
    const failureAfterProbe = failureOf()
    if (failureAfterProbe) throw failureAfterProbe
    if (reachable) {
      return
    }
    if (Date.now() > deadline) {
      throw new ConnectorError(CONTROL_CODES.upstreamUnreachable, `本地 SOCKS 端口 ${port} 等待超时`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
}

function probeTcp(host, port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      resolvePromise(true)
    })
    socket.once('error', () => resolvePromise(false))
    socket.setTimeout(1_000, () => {
      socket.destroy()
      resolvePromise(false)
    })
  })
}

// 起不来的原因分两类:文件不在/不可执行 ⇒ 缺组件(致命,重试无意义,必须给可操作文案);
// 其余 spawn 失败按上游不可达处理,允许退避重连。
function classifySpawnError(error) {
  const code = error?.code
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
    return new ConnectorError(CONTROL_CODES.componentMissing, error?.message)
  }
  return new ConnectorError(CONTROL_CODES.upstreamUnreachable, error?.message)
}

function classifySshExit(code, stderr) {
  if (/Host key verification failed/i.test(stderr)) {
    return new ConnectorError(CONTROL_CODES.hostKeyMismatch)
  }
  if (/Permission denied/i.test(stderr)) {
    return new ConnectorError(CONTROL_CODES.authFailed)
  }
  if (/Address already in use|bind.*failed|ExitOnForwardFailure/i.test(stderr)) {
    return new ConnectorError(CONTROL_CODES.portBusy)
  }
  return new ConnectorError(CONTROL_CODES.upstreamUnreachable, `ssh 退出码 ${String(code)}`)
}

function httpGetBody(socket, url) {
  return new Promise((resolvePromise, rejectPromise) => {
    socket.write(
      `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`
    )
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
    })
    socket.on('close', () => {
      const text = buffer.toString('utf8')
      const separator = text.indexOf('\r\n\r\n')
      if (separator === -1) {
        rejectPromise(new ConnectorError(CONTROL_CODES.upstreamUnreachable, '复验响应畸形'))
        return
      }
      resolvePromise(text.slice(separator + 4).trim())
    })
    socket.on('error', (error) =>
      rejectPromise(new ConnectorError(CONTROL_CODES.upstreamUnreachable, error.message))
    )
  })
}
