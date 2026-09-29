import { Transform } from 'node:stream'

// DL-01: Delivery Optimization 会把 Microsoft Store 内容按约 1 MB 分块并行取回。现场证明
// 线路一般时 25 条会互相挤占、1–4 条更快；线路好时 25 条反而有优势。因此从 4 条起步，
// 只在本次吞吐没有下降时逐级放大，绝不把 4 写成永久上限。
export const DELIVERY_OPTIMIZATION_SUFFIXES = Object.freeze([
  'dl.delivery.mp.microsoft.com',
  'delivery.mp.microsoft.com',
  'windowsupdate.com',
  'update.microsoft.com',
  'storeedgefd.dsx.mp.microsoft.com',
  'download.microsoft.com'
])

export const DELIVERY_OPTIMIZATION_CONCURRENCY_STEPS = Object.freeze([4, 8, 12, 16, 20, 25])
const DEFAULT_SAMPLE_WINDOW_MS = 2_000
const DEFAULT_MIN_SAMPLE_BYTES = 256 * 1024
const DEFAULT_RETRY_COOLDOWN_MS = 30_000
const PERFORMANCE_FLOOR = 0.8
const MAX_PROXY_PREAMBLE_BYTES = 16 * 1024

function normalizedHost(value) {
  return String(value).trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

export function isDeliveryOptimizationHost(host) {
  const candidate = normalizedHost(host)
  return DELIVERY_OPTIMIZATION_SUFFIXES.some((suffix) => candidate === suffix || candidate.endsWith(`.${suffix}`))
}

function abortError() {
  const error = new Error('DOWNLOAD_ADMISSION_CANCELLED')
  error.code = 'DOWNLOAD_ADMISSION_CANCELLED'
  return error
}

/**
 * 对当前一次桥接运行里的 Microsoft Store / Delivery Optimization 分块做自适应准入。
 * 只暂存主机名用于本次匹配，不写日志、状态或诊断包；吞吐仅保留聚合字节数。
 */
export function createDeliveryOptimizationAdmission({
  now = Date.now,
  sampleWindowMs = DEFAULT_SAMPLE_WINDOW_MS,
  minSampleBytes = DEFAULT_MIN_SAMPLE_BYTES,
  retryCooldownMs = DEFAULT_RETRY_COOLDOWN_MS
} = {}) {
  let active = 0
  let concurrentLimit = DELIVERY_OPTIMIZATION_CONCURRENCY_STEPS[0]
  let provenLimit = concurrentLimit
  let referenceBytesPerMs
  let sampleStartedAt = now()
  let sampleBytes = 0
  let retryAfter = 0
  const queued = []

  const nextLimit = (value) => DELIVERY_OPTIMIZATION_CONCURRENCY_STEPS.find((item) => item > value) ?? value
  const previousLimit = (value) => DELIVERY_OPTIMIZATION_CONCURRENCY_STEPS.filter((item) => item < value).at(-1) ?? value

  const flush = () => {
    while (active < concurrentLimit && queued.length > 0) {
      const waiter = queued.shift()
      waiter.grant()
    }
  }

  const evaluate = () => {
    const observedAt = now()
    const elapsed = observedAt - sampleStartedAt
    if (elapsed < sampleWindowMs || sampleBytes < minSampleBytes) return
    const rate = sampleBytes / elapsed
    sampleStartedAt = observedAt
    sampleBytes = 0

    if (referenceBytesPerMs === undefined) {
      referenceBytesPerMs = rate
      concurrentLimit = nextLimit(concurrentLimit)
    } else if (concurrentLimit > provenLimit) {
      if (rate >= referenceBytesPerMs * PERFORMANCE_FLOOR) {
        provenLimit = concurrentLimit
        referenceBytesPerMs = rate
        concurrentLimit = nextLimit(concurrentLimit)
      } else {
        concurrentLimit = provenLimit
        retryAfter = observedAt + retryCooldownMs
      }
    } else if (rate < referenceBytesPerMs * PERFORMANCE_FLOOR && concurrentLimit > DELIVERY_OPTIMIZATION_CONCURRENCY_STEPS[0]) {
      // 已验证档位也会因网络恶化而失效；冷却只限制升档，不阻止继续降档。
      concurrentLimit = previousLimit(concurrentLimit)
      provenLimit = concurrentLimit
      retryAfter = observedAt + retryCooldownMs
    } else {
      // 稳定档位（或最低档）采用当前吞吐，恢复后可重新探索，避免旧高基线永久压住并发。
      referenceBytesPerMs = rate
      if (concurrentLimit < DELIVERY_OPTIMIZATION_CONCURRENCY_STEPS.at(-1) && observedAt >= retryAfter) {
        concurrentLimit = nextLimit(concurrentLimit)
      }
    }
    flush()
  }

  const acquire = (host, signal) => {
    if (!isDeliveryOptimizationHost(host)) return Promise.resolve(undefined)
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return }
      let granted = false
      let released = false
      const release = () => {
        if (released) return
        released = true
        if (!granted) return
        active = Math.max(0, active - 1)
        flush()
      }
      const waiter = {
        grant: () => {
          if (granted || released) return
          if (signal?.aborted) { released = true; reject(abortError()); flush(); return }
          granted = true
          active += 1
          signal?.removeEventListener('abort', cancel)
          resolve({ noteBytes: (bytes) => {
            if (!Number.isSafeInteger(bytes) || bytes <= 0) return
            sampleBytes += bytes
            evaluate()
          }, release })
        }
      }
      const cancel = () => {
        const index = queued.indexOf(waiter)
        if (index >= 0) queued.splice(index, 1)
        if (granted || released) return
        released = true
        reject(abortError())
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (active < concurrentLimit) waiter.grant()
      else queued.push(waiter)
    })
  }

  return {
    acquire,
    status: () => ({ active, queued: queued.length, concurrentLimit, provenLimit })
  }
}

function hostFromAuthority(value) {
  const authority = String(value).trim()
  if (authority.startsWith('[')) return authority.slice(1, authority.indexOf(']'))
  const separator = authority.lastIndexOf(':')
  return separator > 0 ? authority.slice(0, separator) : authority
}

function hostFromHttpHeader(header) {
  const lines = header.toString('latin1').split('\r\n')
  const [method = '', target = ''] = lines[0].split(' ')
  if (method === 'CONNECT') return hostFromAuthority(target)
  try {
    if (/^https?:\/\//i.test(target)) return new URL(target).hostname
  } catch { /* 非 URL 的普通代理请求继续看 Host。 */ }
  const hostLine = lines.find((line) => /^host\s*:/i.test(line))
  const host = hostLine === undefined ? undefined : hostLine.slice(hostLine.indexOf(':') + 1)
  return host === undefined ? undefined : hostFromAuthority(host)
}

/**
 * 在 SOCKS5 CONNECT 或 HTTP 代理请求抵达 Xray 前读出目标主机。只有握手前的极小前缀会暂存；
 * 已知不属于 Delivery Optimization 的流量立即透传。
 */
export function createProxyDestinationAdmissionTransform(admission) {
  let mode = 'unknown'
  let pending = Buffer.alloc(0)
  let lease
  const controller = new AbortController()

  const decide = (chunk) => {
    if (mode === 'passthrough') return { forward: chunk }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    if (pending.length > MAX_PROXY_PREAMBLE_BYTES) {
      const forward = pending
      pending = Buffer.alloc(0)
      mode = 'passthrough'
      return { forward }
    }
    if (mode === 'unknown') mode = pending[0] === 0x05 ? 'socks-greeting' : 'http'

    if (mode === 'socks-greeting') {
      if (pending.length < 2 || pending.length < 2 + pending[1]) return {}
      const greetingLength = 2 + pending[1]
      const greeting = pending.subarray(0, greetingLength)
      pending = pending.subarray(greetingLength)
      mode = 'socks-request'
      if (pending.length === 0) return { forward: greeting }
      const result = decideSocksRequest(pending)
      if (result === undefined) return { forward: greeting }
      mode = 'passthrough'
      const forward = Buffer.concat([greeting, pending])
      pending = Buffer.alloc(0)
      return { forward, host: result }
    }

    if (mode === 'socks-request') {
      const result = decideSocksRequest(pending)
      if (result === undefined) return {}
      mode = 'passthrough'
      const forward = pending
      pending = Buffer.alloc(0)
      return { forward, host: result }
    }

    const headerEnd = pending.indexOf('\r\n\r\n')
    if (headerEnd < 0) return {}
    mode = 'passthrough'
    const forward = pending
    pending = Buffer.alloc(0)
    return { forward, host: hostFromHttpHeader(forward.subarray(0, headerEnd + 4)) }
  }

  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      const decision = decide(Buffer.from(chunk))
      const proceed = async () => {
        if (typeof decision.host === 'string') lease = await admission.acquire(decision.host, controller.signal)
        // 准入可先获批、后恢复此 continuation；销毁若已发生，迟到的名额仍须归还。
        if (controller.signal.aborted) {
          lease?.release()
          lease = undefined
          callback()
          return
        }
        callback(null, decision.forward)
      }
      void proceed().catch((error) => callback(controller.signal.aborted ? undefined : error))
    },
    destroy(error, callback) {
      controller.abort()
      lease?.release()
      lease = undefined
      callback(error)
    }
  })
  return { stream, noteBytes: (bytes) => lease?.noteBytes(bytes) }
}

function decideSocksRequest(buffer) {
  if (buffer.length < 5) return undefined
  // 非 CONNECT 或 IP 目标没有可匹配的 Delivery Optimization 主机，直接放行。
  if (buffer[0] !== 0x05 || buffer[1] !== 0x01) return null
  if (buffer[3] === 0x01) return buffer.length >= 10 ? null : undefined
  if (buffer[3] === 0x04) return buffer.length >= 22 ? null : undefined
  if (buffer[3] !== 0x03) return null
  const length = buffer[4]
  if (buffer.length < 7 + length) return undefined
  return buffer.subarray(5, 5 + length).toString('utf8')
}
