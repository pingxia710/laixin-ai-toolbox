// 常驻运行观测：只记录连接状态、流量计数和进程资源趋势，不记录地址、凭据或请求内容。
// 这是 V1.0 前自动稳定性/性能观测，不是手动诊断包；保留最近 24 小时的 5 分钟样本，写失败不影响通道。
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const RUNTIME_OBSERVATION_VERSION = 1
export const RUNTIME_OBSERVATION_INTERVAL_MS = 5 * 60_000
export const RUNTIME_OBSERVATION_LIMIT = 288
const CLIENT_VERSION_PATTERN = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[-+][A-Za-z0-9.-]{1,32})?$/

/** V1.0 起停止客户端运行观测；未知版本按关闭处理，避免新版本误采集。 */
export function isPreOneRuntimeObservationVersion(version) {
  const match = typeof version === 'string' ? CLIENT_VERSION_PATTERN.exec(version) : null
  return match !== null && Number(match[1]) === 0
}

const STATE_PATTERN = /^(?:idle|connecting|connected|degraded|error|stopped-restored|user-disconnected|shutdown)$/
const STAGE_PATTERN = /^[a-z0-9-]{1,48}$/
const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER

export function runtimeObservationPath(dataDir) {
  return join(dataDir, 'runtime-observation.json')
}

function finiteCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_COUNTER ? value : undefined
}

function finitePercent(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1000 ? Math.round(value * 10) / 10 : undefined
}

/** 逐样本验形；未知字段和自由文本一律丢弃。 */
export function sanitizeRuntimeObservationSample(sample) {
  if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) return undefined
  if (!Number.isFinite(sample.at) || sample.at < 1) return undefined
  if (typeof sample.state !== 'string' || !STATE_PATTERN.test(sample.state)) return undefined
  const rebuilt = { at: Math.round(sample.at), state: sample.state }
  if (typeof sample.stage === 'string' && STAGE_PATTERN.test(sample.stage)) rebuilt.stage = sample.stage
  for (const key of ['reconnectAttempts', 'activeStreams', 'uploadBytes', 'downloadBytes', 'rssBytes', 'heapUsedBytes']) {
    const value = finiteCounter(sample[key])
    if (value !== undefined) rebuilt[key] = value
  }
  const cpuPercent = finitePercent(sample.cpuPercent)
  if (cpuPercent !== undefined) rebuilt.cpuPercent = cpuPercent
  return rebuilt
}

/** 计算一个受控资源样本。previous 只在内存中保存，不落盘。 */
export function buildRuntimeObservationSample({ at, state, stage, reconnectAttempts, traffic, memoryUsage, cpuUsage, previous }) {
  const sample = { at, state, stage, reconnectAttempts,
    activeStreams: traffic?.activeStreams, uploadBytes: traffic?.uploadBytes, downloadBytes: traffic?.downloadBytes,
    rssBytes: memoryUsage?.rss, heapUsedBytes: memoryUsage?.heapUsed }
  if (previous !== undefined && Number.isFinite(at) && at > previous.at &&
      Number.isSafeInteger(cpuUsage?.user) && Number.isSafeInteger(cpuUsage?.system) &&
      Number.isSafeInteger(previous.user) && Number.isSafeInteger(previous.system)) {
    const elapsedMs = at - previous.at
    const deltaMicros = Math.max(0, (cpuUsage.user + cpuUsage.system) - (previous.user + previous.system))
    sample.cpuPercent = Math.min(1000, (deltaMicros / (elapsedMs * 10)))
  }
  const sanitized = sanitizeRuntimeObservationSample(sample)
  if (sanitized === undefined) return undefined
  return {
    sample: sanitized,
    cpu: Number.isSafeInteger(cpuUsage?.user) && Number.isSafeInteger(cpuUsage?.system)
      ? { at, user: cpuUsage.user, system: cpuUsage.system } : undefined
  }
}

export function appendRuntimeObservation(samples, sample, limit = RUNTIME_OBSERVATION_LIMIT) {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : RUNTIME_OBSERVATION_LIMIT
  const sanitized = sanitizeRuntimeObservationSample(sample)
  if (sanitized === undefined) return Array.isArray(samples) ? samples.slice(-safeLimit) : []
  const next = [...(Array.isArray(samples) ? samples : []), sanitized]
  return next.length > safeLimit ? next.slice(next.length - safeLimit) : next
}

export function readRuntimeObservations(path) {
  let text
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) return []
    text = readFileSync(path, 'utf8')
  } catch { return [] }
  let parsed
  try { parsed = JSON.parse(text) } catch { return [] }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.samples)) return []
  const samples = []
  for (const sample of parsed.samples) {
    const sanitized = sanitizeRuntimeObservationSample(sample)
    if (sanitized !== undefined) samples.push(sanitized)
  }
  return samples.slice(-RUNTIME_OBSERVATION_LIMIT)
}

export function writeRuntimeObservations(path, samples) {
  const safeSamples = (Array.isArray(samples) ? samples : [])
    .map((sample) => sanitizeRuntimeObservationSample(sample))
    .filter((sample) => sample !== undefined)
    .slice(-RUNTIME_OBSERVATION_LIMIT)
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`
  try {
    const parent = dirname(path)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    const parentInfo = lstatSync(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || process.platform !== 'win32' && (parentInfo.mode & 0o077) !== 0) {
      throw new Error('RUNTIME_OBSERVATION_DIRECTORY_INVALID')
    }
    writeFileSync(temporary, `${JSON.stringify({ version: RUNTIME_OBSERVATION_VERSION, samples: safeSamples })}\n`, { flag: 'wx', mode: 0o600 })
    const fd = openSync(temporary, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}
