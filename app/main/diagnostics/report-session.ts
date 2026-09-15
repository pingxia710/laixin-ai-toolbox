// 上报通道的 Electron 实现。逻辑判断都在 report-upload.ts 里（那边可测），
// 这里只做一件事：给每条路线一个**私有 session**，按路线固定代理，发出去。
//
// 私有 session 的意义：不带浏览器/账号 cookie，也**不改动任何系统设置**——
// 与网络诊断探针（network-diagnostics/electron-probe.ts）同一套做法。
import { session, type Session } from 'electron'
import type { ReportRoute, ReportTransport } from './report-upload'

const RESPONSE_LIMIT = 16 * 1024

function sessionFor(route: ReportRoute): Session {
  return session.fromPartition(`toolbox-report-${route}`, { cache: false })
}

async function configure(route: ReportRoute): Promise<Session> {
  const target = sessionFor(route)
  await target.closeAllConnections()
  // direct：强制直连，绕开工具箱接管的系统代理与客户自己的代理——客户正断着网，这条必须独立。
  // system：跟随系统设置，给「公司网只准走代理」的机器留一条路。
  await target.setProxy(route === 'direct' ? { mode: 'direct' } : { mode: 'system' })
  return target
}

export function createElectronReportTransport(): ReportTransport {
  return {
    async resolveProxy(url, route) {
      const target = await configure(route)
      return await target.resolveProxy(url)
    },
    async post(url, route, payload, token) {
      const target = await configure(route)
      try {
        const response = await target.fetch(url, {
          method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: payload, signal: AbortSignal.timeout(15_000)
        })
        const text = await readCapped(response)
        return { status: response.status, body: text }
      } finally { await target.closeAllConnections() }
    }
  }
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < RESPONSE_LIMIT) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) { chunks.push(value); size += value.length }
    }
  } finally { await reader.cancel().catch(() => undefined) }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, RESPONSE_LIMIT).toString('utf8')
}

/** 这一刻电脑上的代理读数：Chromium 眼里目标地址会走到哪。⛔ 去读或改任何系统设置。 */
export async function readSystemProxy(urls: Readonly<Record<string, string>>): Promise<Record<string, unknown>> {
  const readings: Record<string, unknown> = {}
  for (const [label, url] of Object.entries(urls)) {
    try { readings[label] = await session.defaultSession.resolveProxy(url) }
    catch (error) { readings[label] = `读不到（${error instanceof Error ? error.name : '未知原因'}）` }
  }
  // 环境变量里的代理设置对命令行 AI 才起作用，客服常要看它；取值过滤闸会抹掉里面的账号密码。
  const env: Record<string, string> = {}
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    const value = process.env[name]
    if (typeof value === 'string' && value !== '') env[name] = value
  }
  return { resolved: readings, env }
}
