import { execFile as execFileCallback } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const runner = join(process.cwd(), 'scripts', 'verify-codex-desktop-route.mjs')

async function invoke(args: readonly string[]): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  try {
    const result = await execFile(process.execPath, [runner, ...args], { cwd: process.cwd(), timeout: 5_000 })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const result = error as { code?: number | null; stdout?: string; stderr?: string }
    return { code: typeof result.code === 'number' ? result.code : null, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

async function liveGateway(body: unknown, status = 200): Promise<{
  readonly url: string
  readonly requestPath: () => string | undefined
  readonly hasAuthorization: () => boolean
  readonly close: () => Promise<void>
}> {
  let requestPath: string | undefined
  let hasAuthorization = false
  const server = createServer((request, response) => {
    requestPath = request.url
    hasAuthorization = typeof request.headers.authorization === 'string'
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  })
  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TEST_GATEWAY_ADDRESS_MISSING')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requestPath: () => requestPath,
    hasAuthorization: () => hasAuthorization,
    close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}

describe('Codex Desktop 诊断脚本', () => {
  it('普通 loopback 服务即使伪造 verified 也只能显示诊断，绝不能构成 Desktop 验收', async () => {
    const gateway = await liveGateway({ status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'verified_socket_bound_desktop' })
    try {
      const result = await invoke(['--gateway', gateway.url])
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({ status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'verified_socket_bound_desktop' })
      expect(result.stderr).toBe('')
      expect(gateway.requestPath()).toBe('/_laixin/codex-desktop-route-status')
      expect(gateway.hasAuthorization()).toBe(false)
    } finally { await gateway.close() }
  })

  it('不接收手工证据；不合合同的状态、CLI、User-Agent 和额外字段都会 fail closed 且不回显内容', async () => {
    const secret = 'sk-fixture-desktop-route-key-must-not-escape'
    const gateway = await liveGateway({ status: 'verified', at: '2026-09-13T00:00:00.000Z', reason: 'manual-claim', userAgent: 'Codex Desktop', authorization: secret })
    try {
      const result = await invoke(['--gateway', gateway.url])
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stdout)).toEqual({ status: 'unverified', at: null, reason: 'socket_binding_unavailable' })
      expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
    } finally { await gateway.close() }

    const evidence = await invoke(['--evidence-file', secret])
    expect(evidence.code).toBe(2)
    expect(JSON.parse(evidence.stdout)).toEqual({ status: 'unverified', at: null, reason: 'socket_binding_unavailable' })
    expect(`${evidence.stdout}${evidence.stderr}`).not.toContain(secret)
  })

  it('只允许无凭据、无查询参数的 127.0.0.1 gateway 地址', async () => {
    const remote = await invoke(['--gateway', 'http://example.test:43100'])
    const query = await invoke(['--gateway', 'http://127.0.0.1:43100/?claim=1'])
    expect(remote.code).toBe(2)
    expect(query.code).toBe(2)
    expect(JSON.parse(remote.stdout)).toEqual({ status: 'unverified', at: null, reason: 'socket_binding_unavailable' })
    expect(JSON.parse(query.stdout)).toEqual({ status: 'unverified', at: null, reason: 'socket_binding_unavailable' })
    expect(`${remote.stdout}${remote.stderr}${query.stdout}${query.stderr}`).not.toContain('example.test')
  })
})
