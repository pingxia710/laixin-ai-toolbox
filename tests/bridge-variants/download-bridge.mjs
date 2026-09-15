import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export const expectedFailure = 'DOWNLOAD_BRIDGE_HANDLER_UNREGISTERED'

export function prepareVerificationProject(tempRoot) {
  writeFileSync(join(tempRoot, 'app/main/actions/download.ts'), mainActionSource)
}

// AC-01 起工具箱免费,download.* 不再有付费闸(app/main/account/toolbox-access.ts 已删除),
// 真实 Electron 里未登录直接调用 download.start 就能通——本变体验的是桥接线通不通。
// 若有人把付费闸加回装配层,这里的未登录调用会拒成 ACCOUNT_LOGIN_REQUIRED,变体当场红。

export function mutateVerificationProject(tempRoot) {
  const path = join(tempRoot, 'app/main/actions/download.ts')
  const source = readFileSync(path, 'utf8')
  const needle = "name: 'download.start'"
  if (!source.includes(needle)) throw new Error(`VERIFY_BRIDGE_MUTATION_TARGET_MISSING:${path}`)
  writeFileSync(path, source.replace(needle, "name: 'download.absent'"))
}

export async function verifyBeforeMutation({ tempRoot, root }) {
  const result = await invokeDownloadBridge(tempRoot, root)
  if (result.status !== 'resolved' || result.taskId !== 'download-fixture' || result.state !== 'ready') {
    throw new Error(`DOWNLOAD_BRIDGE_VALID_RESULT_MISSING:${JSON.stringify(result)}`)
  }
  process.stdout.write(`DOWNLOAD_BRIDGE_VALID_RESULT=${JSON.stringify(result)}\n`)
}

export async function verifyAfterMutation({ tempRoot, root }) {
  const result = await invokeDownloadBridge(tempRoot, root)
  if (result.status !== 'rejected' || !result.message.includes('ACTION_NOT_FOUND')) {
    throw new Error(`DOWNLOAD_BRIDGE_COUNTERFACTUAL_DID_NOT_FAIL:${JSON.stringify(result)}`)
  }
  process.stdout.write(`DOWNLOAD_BRIDGE_HANDLER_REMOVED=${JSON.stringify(result)}\n`)
  throw new Error(expectedFailure)
}

async function invokeDownloadBridge(tempRoot, root) {
  let resolveResult
  let rejectResult
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (requestUrl.pathname === '/index.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8')
      response.end('<script src="/probe.js"></script>')
      return
    }
    if (requestUrl.pathname === '/probe.js') {
      response.setHeader('content-type', 'application/javascript; charset=utf-8')
      response.end(
        "window.toolbox.download.start('fixture').then((value) => fetch(`/result?status=resolved&taskId=${encodeURIComponent(value.taskId)}&state=${encodeURIComponent(value.state)}`)).catch((error) => fetch(`/result?status=rejected&message=${encodeURIComponent(String(error.message))}`));"
      )
      return
    }
    if (requestUrl.pathname === '/result') {
      resolveResult({
        status: requestUrl.searchParams.get('status'),
        taskId: requestUrl.searchParams.get('taskId'),
        state: requestUrl.searchParams.get('state'),
        message: requestUrl.searchParams.get('message') ?? ''
      })
      response.statusCode = 204
      response.end()
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('DOWNLOAD_BRIDGE_PROBE_LISTEN_FAILED')
  }
  const electron = spawn(join(root, 'node_modules/.bin/electron'), ['out/main/index.js'], {
    cwd: tempRoot,
    env: { ...process.env, ELECTRON_RENDERER_URL: `http://127.0.0.1:${address.port}/index.html` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const timeout = setTimeout(() => rejectResult(new Error('DOWNLOAD_BRIDGE_PROBE_TIMEOUT')), 10_000)
  try {
    return await result
  } finally {
    clearTimeout(timeout)
    electron.kill()
    server.close()
  }
}

const mainActionSource = `import type { BridgeRegistry } from '../bridge/bridge-registry'
import type { DownloadManager } from '../download/download-manager'
import { schema } from '../bridge/schema'

export function registerActions(registry: BridgeRegistry): void {
  registry.registerAction({
    name: 'download.start',
    paramsSchema: schema.object({ resourceId: schema.string({ maxLength: 100 }) }),
    resultSchema: schema.object({
      taskId: schema.string({ maxLength: 100 }),
      state: schema.string({ maxLength: 100 })
    }),
    handler: () => ({ taskId: 'download-fixture', state: 'ready' })
  })
}

export function registerDownloadActions(registry: BridgeRegistry, _manager: DownloadManager): void {
  registerActions(registry)
}
`
