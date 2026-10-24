#!/usr/bin/env node
/* global AbortController, TextDecoder, URL, clearTimeout, fetch, process, setTimeout */
/**
 * Read the current Toolbox gateway's in-memory Codex Desktop proof. This script never launches
 * Codex, changes a configuration, sends a Key, calls an upstream, or imports JSON evidence.
 * A loopback HTTP response cannot prove that it came from the current Toolbox process, so this
 * is diagnostic-only. It never establishes Desktop acceptance or exits successfully for it.
 */
import { readGatewayDesktopRouteStatus, unavailableDesktopRouteResult } from './verify-codex-desktop-route-output.mjs'

const parsed = parseOptions(process.argv.slice(2))
if (parsed.help) {
  process.stdout.write(`用法：node scripts/verify-codex-desktop-route.mjs --gateway http://127.0.0.1:端口\n\n` +
    '这只是本机诊断：它不会作为桌面版验收通过，也不会以成功状态退出。loopback 地址可被其它本机进程占用或伪造。真正的 Desktop 验收只看正在运行的工具箱模型 API 页中的「Codex 桌面版已验证」步骤；该步骤由同一 Electron 主进程核对当前连接、官方签名和完整回答。\n')
  process.exitCode = 0
} else if (parsed.url === undefined) {
  write(unavailableDesktopRouteResult())
  process.exitCode = 2
} else {
  const result = await liveGatewayStatus(parsed.url)
  write(result)
  // A caller-controlled loopback port may be any local process. Keep its fixed three-field
  // response useful for diagnosis, but never let it turn an external script into acceptance.
  process.exitCode = 1
}

function write(result) { process.stdout.write(`${JSON.stringify(result)}\n`) }

function parseOptions(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true, url: undefined }
  if (args.length !== 2 || args[0] !== '--gateway') return { help: false, url: undefined }
  return { help: false, url: localGatewayStatusUrl(args[1]) }
}

function localGatewayStatusUrl(value) {
  if (typeof value !== 'string' || value.length > 200) return undefined
  try {
    const parsed = new URL(value)
    const port = Number(parsed.port)
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65_535 ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return undefined
    return `http://127.0.0.1:${String(port)}/_laixin/codex-desktop-route-status`
  } catch { return undefined }
}

async function liveGatewayStatus(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3_000)
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal })
    if (!response.ok) return unavailableDesktopRouteResult()
    const body = await boundedBody(response, 4_096)
    if (body === undefined) return unavailableDesktopRouteResult()
    try { return readGatewayDesktopRouteStatus(JSON.parse(body)) } catch { return unavailableDesktopRouteResult() }
  } catch { return unavailableDesktopRouteResult() } finally { clearTimeout(timer) }
}

async function boundedBody(response, maximum) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > maximum) return undefined
      chunks.push(next.value)
    }
    const combined = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length }
    return new TextDecoder().decode(combined)
  } catch { return undefined } finally { reader.releaseLock() }
}
