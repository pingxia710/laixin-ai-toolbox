// 复用 01 朋友包的 Xray -> SSH SOCKS 转发结构；协议处理交给官方内核。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer, isIP } from 'node:net'
import { uptime } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TUNNEL_PROBE_URLS, probeTunnelReachability, verifyWithFallback } from './vless-connector.mjs'
import { CONTROL_CODES, ConnectorError } from './connectors.mjs'
import { validVerifyFallbackUrl } from './vless-settings.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function xrayExecutable() {
  const name = process.platform === 'win32' ? 'xray.exe' : 'xray'
  const packaged = join(root, 'xray', name)
  return existsSync(packaged) ? packaged : join(root, 'vendor', 'xray', `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`, name)
}

// 局域网名(D4):mDNS 的 .local(RFC 6762)、家庭网 home.arpa(RFC 8375)与常见的 localdomain。
// 没有这条规则时它们一条都不命中,落到默认出站 = 走通道:局域网打印机、NAS、投屏全断,
// 而且本机的名字会被发到远端去解析。必须直连,且排在签名补充规则之前 ⛔ 被划进通道。
// localhost 不在此列:它的位置(后缀表之后、GeoIP 之前)是既有约定,本包不动。
export const LOCAL_NETWORK_DIRECT_SUFFIXES = Object.freeze(['local', 'home.arpa', 'localdomain'])

// 隐藏多节点(创始人 09-13 晚放行):`outbounds` 给多个入口时,内核自己探活并挑能用的那条,
// 某条被掐掉时下一个请求就走别的(本机实测 0 秒),客户界面上仍只有「连接」。
// 单入口(只给 `outbound` 或都不给)时探活/均衡器形状与从前一字不差。
// 通道出站的 tag:单入口沿用历史名 'ssh-socks';多入口是 'tunnel-0..N' + 一个名为 'tunnel' 的均衡器。
export const TUNNEL_OUTBOUND_TAG = 'ssh-socks'
export const TUNNEL_BALANCER_TAG = 'tunnel'
// 专用出站(CH-1,创始人 2026-09-15 定):AI 和 GitHub 的域名走这里,与其余国外的通用出站分开。
// 专用与通用**共享同一批入口**(01A 验证过的「共享故障域」结构,节点整体死了两路一起死)——
// 「专用」只是结构分开:独立的出站对象(独立连接路径)与独立的均衡器/探活,
// 与通用一样正常参与故障转移。⛔ 指到别的服务器、⛔ 固定出口/防漂移/DNS 相关任何设计。
// tag 命名与通用那对同构:单入口用出站 tag 'dedicated',多入口是 'dedicated-0..N' + 均衡器 'dedicated'。
export const DEDICATED_OUTBOUND_TAG = 'dedicated'
export const DEDICATED_BALANCER_TAG = 'dedicated'
// 入口探活间隔。两层分工(本机实测定的,⛔ 拍脑袋):
//  · 内核这一层**不是**用来秒级切换的——实测掐掉正在用的入口后,内核要等下一轮探活才知道,
//    间隔多长暴露窗口就多长。它的职责是「长期不通的入口不要被选中」。
//  · 「坏了赶紧换」归守护层:被动检测 10 秒内 3 条失败即复验,复验不过就轮转入口重连(约 10~20 秒回来)。
// 所以间隔按流量定:每轮每入口一个 204 请求(含 TLS 握手约 5 KB),300 秒 × 3 入口 ≈ 每天 2 MB——
// 客户套餐里这是能接受的一笔;缩到 20 秒就是每天 30 MB,⛔。
export const ENTRY_PROBE_INTERVAL_SECONDS = 300

export function buildXrayConfig({ listenPort, upstream, routes, outbound, outbounds, verifyUrl, verifyFallbackUrl, probeUrls, probeIntervalSeconds }) {
  const entries = Array.isArray(outbounds) && outbounds.length > 0 ? outbounds : undefined
  const multi = entries !== undefined && entries.length > 1
  const dedicated = routes?.dedicatedSuffixes ?? []
  // 通道流量的去向:单入口指向那个出站,多入口交给均衡器。两者在规则里只差一个字段名。
  const tunnelTarget = multi ? { balancerTag: TUNNEL_BALANCER_TAG } : { outboundTag: TUNNEL_OUTBOUND_TAG }
  // 专用流量的去向:与通用同构,单入口指出站、多入口交专用均衡器。
  const dedicatedTarget = multi ? { balancerTag: DEDICATED_BALANCER_TAG } : { outboundTag: DEDICATED_OUTBOUND_TAG }
  const rules = []
  // 复验必须经过通道，不能被本地地址/国内直连规则截走而误报已连。
  if (verifyFallbackUrl !== undefined && !validVerifyFallbackUrl(verifyUrl, verifyFallbackUrl)) throw new Error('VERIFY_FALLBACK_INVALID')
  // 通用探测点与回显地址一样必须走通道,否则测不到通道。
  const probes = probeUrls ?? TUNNEL_PROBE_URLS
  const probeTargets = verifyUrl === undefined ? [] : probes
  for (const target of [verifyUrl, verifyFallbackUrl, ...probeTargets].filter(Boolean)) {
    const url = new URL(target)
    const host = url.hostname.replace(/^\[|\]$/g, '')
    rules.push({ type: 'field', inboundTag: ['local-mixed'], port: url.port || (url.protocol === 'https:' ? '443' : '80'), ...(isIP(host) ? { ip: [host] } : { domain: [`full:${host}`] }), ...tunnelTarget })
  }
  const domainRule = (suffixes, target) => {
    if (suffixes?.length) rules.push({ type: 'field', domain: suffixes.map((suffix) => `domain:${suffix}`), ...(typeof target === 'string' ? { outboundTag: target } : target) })
  }
  // 局域网名排在最前:任何签名补充规则都不能把局域网里的名字送出去。
  domainRule(LOCAL_NETWORK_DIRECT_SUFFIXES, 'direct')
  domainRule(routes?.protectedDirectSuffixes, 'direct')
  // 专用(CH-1)排在签名补充之前:overlay 改不了专用指向;又排在一切普通直连之前:三类域名先分流。
  domainRule(dedicated, dedicatedTarget)
  domainRule(routes?.tunnelSuffixes, tunnelTarget)
  // GeoSite 是 Xray 数据选择器，必须原样保留，不能混入会加 domain: 前缀的后缀表。
  rules.push({ type: 'field', domain: ['geosite:cn'], outboundTag: 'direct' })
  domainRule(routes?.directSuffixes, 'direct')
  domainRule(['localhost'], 'direct')
  rules.push({ type: 'field', ip: ['geoip:private', 'geoip:cn'], outboundTag: 'direct' })
  const tunnelOutbounds = multi
    ? entries.map((entry, index) => ({ ...entry, tag: `${TUNNEL_BALANCER_TAG}-${String(index)}` }))
    : [entries?.[0] ?? outbound ?? { tag: TUNNEL_OUTBOUND_TAG, protocol: 'socks', settings: { servers: [{ address: upstream.host, port: upstream.port }] }, streamSettings: { sockopt: { domainStrategy: 'AsIs' } } }]
  if (!multi) tunnelOutbounds[0] = { ...tunnelOutbounds[0], tag: TUNNEL_OUTBOUND_TAG }
  // 专用出站 = 通用那批出站的逐项镜像(同上游同凭据,独立出站对象):结构分开、故障域同批。
  // 镜像必须深拷贝:出站对象里内嵌的 servers 等若与通用共享引用,改坏通用那侧就会渗到专用这侧,
  // 「两条路分开」就成了空话。出站对象本来就是纯 JSON(要原样写进内核配置),按 JSON 深拷贝最稳。
  // 单节点镜像唯一的通用出站后,流量仍由同一节点承载 —— 客户侧行为与从前一致。
  const dedicatedOutbounds = dedicated.length
    ? tunnelOutbounds.map((entry, index) => ({ ...JSON.parse(JSON.stringify(entry)), tag: multi ? `${DEDICATED_BALANCER_TAG}-${String(index)}` : DEDICATED_OUTBOUND_TAG }))
    : []
  return {
    // 不记录请求网址、查询参数、报文或认证内容。
    log: { access: 'none', error: 'none', loglevel: 'none' },
    inbounds: [{ tag: 'local-mixed', listen: '127.0.0.1', port: listenPort, protocol: 'socks', settings: { auth: 'noauth', udp: false } }],
    outbounds: [...tunnelOutbounds, ...dedicatedOutbounds, { tag: 'direct', protocol: 'freedom' }],
    // 多入口才装探活:内核周期性经每个入口打一次通用探测点,均衡器据此排除掉不通的那条。
    // 专用组在列:它和通用一样正常参与故障转移(创始人 09-15 撤「专用不参与」的原设计)。
    ...(multi ? { observatory: {
      subjectSelector: [`${TUNNEL_BALANCER_TAG}-`, ...(dedicated.length ? [`${DEDICATED_BALANCER_TAG}-`] : [])], probeUrl: probes[0],
      probeInterval: `${String(probeIntervalSeconds ?? ENTRY_PROBE_INTERVAL_SECONDS)}s`, enableConcurrency: true
    } } : {}),
    routing: {
      domainStrategy: 'AsIs',
      ...(multi ? { balancers: [
        { tag: TUNNEL_BALANCER_TAG, selector: [`${TUNNEL_BALANCER_TAG}-`], strategy: { type: 'leastPing' } },
        ...(dedicated.length ? [{ tag: DEDICATED_BALANCER_TAG, selector: [`${DEDICATED_BALANCER_TAG}-`], strategy: { type: 'leastPing' } }] : [])
      ] } : {}),
      rules
    }
  }
}

export function createLocalBridge(options) {
  let child
  let exited
  let relay
  let stopped = true
  let failure
  let lost
  let degraded
  let port = options.listenPort
  const spawnImpl = options.spawnImpl ?? spawn
  const platform = options.platform ?? process.platform
  const relaySockets = new Set()
  // 在途流(D3):已经回过数据、还没结束的连接数。AI 的流式回答就是这种连接。
  // relay 只看得到本机 xray 怎么收尾,分不出远端是正常结束还是半路截断;
  // 但「通道断的那一刻有几条连接正在回数据」是守护确定知道的事实——
  // 客户说的「回答到一半断掉」按那个口径统计(见 daemon-core)。⛔ 记网址、报文与任何正文。
  const traffic = { uploadBytes: 0, downloadBytes: 0, activeStreams: 0 }
  const fail = () => new ConnectorError(CONTROL_CODES.upstreamUnreachable, '代理内核未就绪')

  return {
    port: () => port,
    // 仅累计经过本机代理入口的字节数；不解析或保存主机名、URL、报文和凭据。
    traffic: () => ({ ...traffic, observedAt: Date.now() }),
    verify: options.verifyUrl ? () => verifyWithFallback(port, options.verifyUrl, options.verifyFallbackUrl, options.verifyTimeoutMs) : undefined,
    // 回显打不通时的第二意见:通用探测点经通道可达 = 通道活着(见 daemon-core.verifyConnection)。
    probeReachability: options.verifyUrl ? () => probeTunnelReachability(port, options.probeUrls ?? TUNNEL_PROBE_URLS, options.verifyTimeoutMs) : undefined,
    isAlive: () => child !== undefined && child.exitCode === null && child.signalCode === null && failure === undefined,
    onLost: (callback) => { lost = callback },
    // 被动检测(照 mihomo 的 onDialFailed):客户真实请求在通道里连续失败,就立刻通知守护复验,⛔ 干等 30 秒定时。
    onDegraded: (callback) => { degraded = callback },
    async listen() {
      if (!stopped) throw new Error('BRIDGE_ALREADY_STARTED')
      if (!options.outbound && !(options.outbounds?.length > 0) && options.upstream?.host !== '127.0.0.1') throw fail()
      const executable = options.executablePath ?? xrayExecutable()
      // 内核文件不在(装包不全,或被安全软件隔离)是缺组件 ⛔ 「上游不可达」:按上游不可达报会无限重连,
      // 而每次重连都起不来,系统代理却一直挂着 → 整机断网。缺组件是致命码:守护立刻停、先恢复代理、给人话。
      if (!existsSync(executable)) throw new ConnectorError(CONTROL_CODES.componentMissing, '代理内核缺失或已被安全软件隔离，请把工具箱目录加入安全软件白名单后重新安装')
      const missingAsset = ['geoip.dat', 'geosite.dat'].find((name) => !existsSync(join(dirname(executable), name)))
      if (missingAsset) throw new ConnectorError(CONTROL_CODES.componentMissing, `分流数据缺失（${missingAsset}），请重新安装工具箱`)
      // 入口端口由 relay 直接占用，避免检查完成到监听之间被其他本机进程抢占。
      const requestedPort = port ?? 0
      let xrayPort = await availablePort(0)
      while (requestedPort > 0 && xrayPort === requestedPort) xrayPort = await availablePort(0)
      mkdirSync(options.dataDir, { recursive: true })
      const config = join(options.dataDir, 'xray-bridge.json')
      const pidPath = `${config}.pid`
      // 上次 runner 被硬杀(Windows TerminateProcess)时 close 钩子不跑,pid 记档留在磁盘、
      // 内核还活着。启动前按记档清扫,⛔ 直接覆盖记档把旧 xray 留成没人管的孤儿。
      sweepOrphanXray(pidPath, platform, imageNameOf(executable), spawnImpl)
      writeFileSync(config, JSON.stringify(buildXrayConfig({ ...options, listenPort: xrayPort })), { mode: 0o600 })
      stopped = false
      failure = undefined
      // runner 的 stdin 是停止管道:close() 关闭它,runner 见 EOF 即停 xray(跨平台可靠)。
      // stderr 接进守护的 stderr(甲-6:runner 把内核 stderr 转发到那里 → 守护日志 → 诊断包)。
      child = spawnImpl(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'xray-runner.mjs'), executable, config, String(process.pid)], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true
      })
      exited = new Promise((resolve) => {
        child.once('error', () => { failure = fail() })
        child.once('close', () => {
          failure ??= fail()
          void closeTrafficRelay(relay, relaySockets)
          relay = undefined
          resolve()
          if (!stopped) lost?.(failure)
        })
      })
      try {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          if (failure !== undefined) break
          if (await probeSocks(xrayPort)) {
            const detector = createFailureDetector({ onDegraded: () => degraded?.() })
            const listener = await startTrafficRelay(requestedPort, xrayPort, traffic, relaySockets, options.idleStreamMs, detector)
            relay = listener.server
            port = listener.port
            if (await probeSocks(port)) return
            break
          }
        }
        throw failure ?? fail()
      } catch (error) {
        await this.close()
        throw error
      }
    },
    async close() {
      stopped = true
      await closeTrafficRelay(relay, relaySockets)
      relay = undefined
      if (child === undefined) return
      if (child.exitCode === null && child.signalCode === null) {
        // 主停止通道:关 stdin 管道;runner 收到 EOF 即停 xray。
        // Windows 上 child.kill('SIGTERM') 等于 TerminateProcess,runner 的清理钩子不会跑,
        // 会把占着端口和含 UUID 配置的 xray.exe 留成孤儿,⛔ 作停止信号依赖。
        child.stdin?.end()
      }
      const timer = setTimeout(() => {
        if (child === undefined || (child.exitCode !== null || child.signalCode !== null)) return
        // 兜底:管道未停成 → 按记档 pid 连 xray 一起强杀(Windows),再杀 runner。
        if (platform === 'win32') {
          const pid = readXrayRecord(join(options.dataDir, 'xray-bridge.json.pid'))?.pid
          if (pid !== undefined) {
            try { spawnImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* 强杀失败时下方仍杀 runner。 */ }
          }
        }
        child.kill('SIGKILL')
      }, 1_000)
      try { await exited } finally { clearTimeout(timer); child = undefined }
    }
  }
}

function startTrafficRelay(port, targetPort, traffic, sockets, idleStreamMs = IDLE_STREAM_MS, detector = createFailureDetector()) {  return new Promise((resolve, reject) => {
    const server = createServer((client) => {
      const upstream = connect({ host: '127.0.0.1', port: targetPort })
      sockets.add(client); sockets.add(upstream)
      // 「在途流」= 这条连接**此刻正在往回吐回答**。⛔ 记它连的是谁。
      // 起算点是正文第一个字节,⛔ 上游回的第一个字节——relay 与 xray 之间走 SOCKS5,
      // 上游回的第一个字节是 xray 的问候应答,那时客户连请求都还没发出去。
      // 销账有两条:连接结束,或者静下来超过空闲窗口(回答回完的 keep-alive 连接就停在这)。
      const life = { streaming: false, idle: undefined, reported: false }
      const payload = upstreamPayloadReader()
      // 连接收尾时给被动检测器一个结论:失败(握手应答明说失败 / 请求发出去了却一个字节都没回)或成功(回过正文)。
      const report = () => {
        if (life.reported) return
        life.reported = true
        detector.report(payload.verdict())
      }
      const settle = () => {
        if (life.idle !== undefined) { clearTimeout(life.idle); life.idle = undefined }
        if (!life.streaming) return
        life.streaming = false
        traffic.activeStreams = Math.max(0, traffic.activeStreams - 1)
      }
      const keepAlive = () => {
        if (life.idle !== undefined) clearTimeout(life.idle)
        // ⛔ 让这个定时器把进程吊住:它只是计量,进程该退就退。
        life.idle = setTimeout(settle, idleStreamMs)
        life.idle.unref?.()
      }
      const close = () => { client.destroy(); upstream.destroy() }
      const forget = () => { sockets.delete(client); sockets.delete(upstream) }
      client.on('data', (chunk) => { traffic.uploadBytes += chunk.length; payload.noteRequest(chunk) })
      upstream.on('data', (chunk) => {
        traffic.downloadBytes += chunk.length
        if (!payload.consume(chunk)) return // 还在握手应答里,⛔ 当成回答
        if (!life.streaming) { life.streaming = true; traffic.activeStreams += 1 }
        keepAlive()
      })
      client.once('error', close); upstream.once('error', close)
      // 上游把回答发完并收尾(FIN):这条回答结束了,⛔ 等空闲窗口才销账。
      upstream.once('end', settle)
      client.once('close', () => { settle(); forget(); report() })
      upstream.once('close', () => { settle(); forget(); report() })
      client.pipe(upstream); upstream.pipe(client)
    })
    server.once('error', () => reject(new ConnectorError(CONTROL_CODES.portBusy)))
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new ConnectorError(CONTROL_CODES.portBusy)))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

// 回答停多久算「不在回答了」。⛔ 靠解析正文判断回答有没有结束——那要按 HTTP/SSE 逐协议拆包,
// relay 这一层不看正文;静下来这么久还没有新字节,就当这条回答已经停了。
const IDLE_STREAM_MS = 15_000

/** CONNECT 应答的头攒到这么大还没见到空行,就不再等了,⛔ 无限攒 buffer。 */
const MAX_CONNECT_REPLY_BYTES = 8 * 1024

/**
 * 上游字节里把「握手应答」和「回答正文」分开。xray 的 local-mixed 入站两种客户端都接:
 * - **SOCKS5**:上游先回 2 字节方法选择,(必要时 2 字节认证应答,)再回一条 CONNECT 应答
 *   (VER REP RSV ATYP BND.ADDR BND.PORT),之后才是目标站点的正文。
 * - **HTTP CONNECT**(实际客户端大多走这条):上游先回一条 `HTTP/1.1 200 Connection established`
 *   加一个空行,那是「隧道建好了」,之后才是正文。
 *
 * 难点在于 **CONNECT 应答与「普通代理 GET 的回答」开头都是 `HTTP/1.1 200`**,从上游字节上分不开;
 * 分辨只能看客户端那一行请求是不是 `CONNECT `——所以 noteRequest 要把客户端的头几个字节喂进来。
 * 两种都不像就从第一个字节起全算正文,⛔ 硬按某个协议去掐掉真正的回答。
 * consume 返回 true 表示这一段里已经出现正文。
 */
export function upstreamPayloadReader() {
  let stage = 'unknown'
  let pending = Buffer.alloc(0)
  let request = Buffer.alloc(0)
  let requestDecided = false
  let tunnelRequest = false
  // 被动检测用的三个事实:客户端一共发了多少字节、握手应答收齐时客户端发到了多少字节、握手应答有没有明说失败。
  let clientBytes = 0
  let upstreamBytes = 0
  let handshakeDoneAt = -1
  let handshakeFailed = false
  let payloadSeen = false
  const toPayload = () => { stage = 'payload'; pending = Buffer.alloc(0); payloadSeen = true; return true }
  const handshakeDone = (failed) => { handshakeDoneAt = clientBytes; handshakeFailed = failed }
  return {
    // 客户端的头 8 个字节:`CONNECT ` 说明上游接下来那条 HTTP 应答是隧道建立,不是回答正文。
    noteRequest(chunk) {
      clientBytes += chunk.length
      if (requestDecided) return
      request = Buffer.concat([request, chunk]).subarray(0, 8)
      if (request.length < 8) return
      requestDecided = true
      tunnelRequest = request.toString('latin1') === 'CONNECT '
    },
    /**
     * 这条连接收尾时的结论(给被动检测器):
     * - 'failed':握手应答明说失败(SOCKS5 REP≠0 / CONNECT 非 2xx),或握手成功后客户端又发了请求(TLS ClientHello 等)
     *   却一个正文字节都没回来就断了,或者压根没有任何上游应答而客户端已经发过请求;
     * - 'ok':回过正文;
     * - 'none':客户端什么都没发就走了(预连接/探路),不算数。
     */
    verdict() {
      if (handshakeFailed) return 'failed'
      if (payloadSeen) return 'ok'
      if (clientBytes === 0) return 'none'
      if (handshakeDoneAt >= 0) return clientBytes > handshakeDoneAt ? 'failed' : 'none'
      // 握手没走完就断了:上游一个字节都没回(普通代理 GET 发出去了没回、SOCKS 问候没人应)算失败;
      // 上游应过问候、客户端没继续(本机探活就是这种)不算数。
      return upstreamBytes === 0 ? 'failed' : 'none'
    },
    consume(chunk) {
      upstreamBytes += chunk.length
      if (stage === 'payload') { payloadSeen = true; return true }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      if (stage === 'unknown') {
        if (pending[0] === 0x05) stage = 'method'
        else if (!tunnelRequest) return toPayload() // 普通代理 GET 之类:第一个字节就是回答
        else if (pending.length < 5) return false // 等够 'HTTP/' 再判
        else if (pending.toString('latin1', 0, 5) === 'HTTP/') stage = 'connect-reply'
        else return toPayload()
      }
      if (stage === 'connect-reply') {
        const blank = pending.indexOf('\r\n\r\n')
        const end = blank >= 0 ? blank + 4 : -1
        if (end < 0) return pending.length > MAX_CONNECT_REPLY_BYTES ? toPayload() : false
        const status = Number.parseInt(pending.toString('latin1', 0, Math.min(pending.length, 16)).split(' ')[1] ?? '', 10)
        handshakeDone(!(Number.isFinite(status) && status >= 200 && status < 300))
        const rest = pending.subarray(end)
        stage = 'payload'
        pending = Buffer.alloc(0)
        if (rest.length > 0) payloadSeen = true
        return rest.length > 0
      }
      for (;;) {
        if (stage === 'method' || stage === 'auth') {
          if (pending.length < 2) return false
          const next = stage === 'method' && pending[1] === 0x02 ? 'auth' : 'connect'
          pending = pending.subarray(2)
          stage = next
          if (stage !== 'connect') continue
        }
        if (pending.length < 5) return false
        const type = pending[3]
        const length = type === 0x01 ? 10 : type === 0x04 ? 22 : type === 0x03 ? 7 + pending[4] : 0
        // 认不出的地址类型:⛔ 继续硬猜,后面的字节一律当正文。
        if (length === 0) return toPayload()
        if (pending.length < length) return false
        handshakeDone(pending[1] !== 0x00) // SOCKS5 REP:0 成功,其余(1 一般失败/5 连接被拒…)都是失败
        const rest = pending.subarray(length)
        stage = 'payload'
        pending = Buffer.alloc(0)
        if (rest.length > 0) payloadSeen = true
        return rest.length > 0
      }
    }
  }
}

// 被动检测器(照 mihomo groupbase.onDialFailed 的形状):窗口内连续失败到阈值就通知守护立刻复验;
// 一条成功就清零。只数次数 ⛔ 记目标。默认 10 秒内 3 条。
export const PASSIVE_FAILURE_THRESHOLD = 3
export const PASSIVE_FAILURE_WINDOW_MS = 10_000
export function createFailureDetector({ onDegraded = () => undefined, threshold = PASSIVE_FAILURE_THRESHOLD, windowMs = PASSIVE_FAILURE_WINDOW_MS, now = Date.now } = {}) {
  let failures = []
  return {
    report(verdict) {
      if (verdict === 'ok') { failures = []; return false }
      if (verdict !== 'failed') return false
      const at = now()
      failures = failures.filter((time) => at - time <= windowMs)
      failures.push(at)
      if (failures.length < threshold) return false
      failures = []
      onDegraded()
      return true
    },
    pendingFailures: () => failures.length
  }
}

function closeTrafficRelay(relay, sockets) {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  if (!relay || !relay.listening) return Promise.resolve()
  return new Promise((resolve) => relay.close(() => resolve()))
}

// 映像名按两种分隔符取尾:记档在 Windows 上写,⛔ 依赖当前平台的 path 语义。
function imageNameOf(executablePath) {
  return String(executablePath).split(/[\\/]/).pop()
}

// pid 记档:当前是 {pid,startedAt,image} 的 JSON;升级前留下的纯数字记档也认。
function readXrayRecord(pidPath) {
  let text
  try { text = readFileSync(pidPath, 'utf8').trim() } catch { return undefined }
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  // 旧记档是裸数字:JSON.parse 会把它解析成 number 而不是对象,⛔ 当成无记档丢掉。
  if (typeof parsed === 'number') parsed = { pid: parsed }
  if (parsed === null || typeof parsed !== 'object') parsed = { pid: Number.parseInt(text, 10) }
  const pid = Number(parsed.pid)
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  return {
    pid,
    startedAt: Number.isFinite(parsed.startedAt) ? Number(parsed.startedAt) : undefined,
    image: typeof parsed.image === 'string' && parsed.image !== '' ? parsed.image : undefined
  }
}

// 启动前清扫:记档里的内核若还活着就先杀掉,再起新的。
// 防 PID 复用误杀两道闸:①记档的启动时刻早于本次开机 ⇒ 那个进程必已消失,只删记档不杀;
// ②taskkill 带映像名过滤,只有这个 pid 现在仍是我们的内核映像才会被终止。
function sweepOrphanXray(pidPath, platform, imageName, spawnImpl) {
  const record = readXrayRecord(pidPath)
  if (record === undefined) return
  const bootedAt = Date.now() - uptime() * 1_000
  const beforeThisBoot = record.startedAt !== undefined && record.startedAt < bootedAt - 60_000
  if (platform === 'win32' && !beforeThisBoot) {
    const image = record.image ?? imageName
    try {
      spawnImpl('taskkill', ['/F', '/T', '/FI', `PID eq ${String(record.pid)}`, '/FI', `IMAGENAME eq ${image}`],
        { stdio: 'ignore', windowsHide: true })
    } catch { /* 清扫失败不挡启动:新内核用新端口,旧孤儿下次启动再扫。 */ }
  }
  // 记档已作废:留着会让本次 close 的兜底按旧 pid 强杀(新 runner 若没来得及写记档)。
  try { rmSync(pidPath, { force: true }) } catch { /* 删不掉也不挡启动。 */ }
}

function availablePort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', () => reject(new ConnectorError(CONTROL_CODES.portBusy)))
    server.listen(port, '127.0.0.1', () => {
      const allocated = server.address().port
      server.close(() => resolve(allocated))
    })
  })
}

function probeSocks(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (ok) => { socket.destroy(); resolve(ok) }
    socket.on('error', () => finish(false))
    socket.setTimeout(200, () => finish(false))
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])))
    socket.once('data', (data) => finish(data[0] === 5 && data[1] === 0))
    socket.on('end', () => finish(false))
  })
}
