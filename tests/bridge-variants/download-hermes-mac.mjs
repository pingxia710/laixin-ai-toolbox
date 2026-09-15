import { chmodSync, copyFileSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

export const expectedFailure = 'DOWNLOAD_HERMES_BRIDGE_HANDLER_UNREGISTERED'

const fixture = await createDownloadFixture()

export function prepareVerificationProject(tempRoot) {
  writeFixtureCatalog(tempRoot, fixture.assetUrl, fixture.byteLength, fixture.sha256)
  writeFixtureTunnel(tempRoot, fixture.proxyUrl)
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
  if (
    result.status !== 'resolved' ||
    result.state !== 'ready' ||
    result.message !== '官方值一致' ||
    !result.taskId ||
    !result.totalBytes
  ) {
    throw new Error(`DOWNLOAD_HERMES_BRIDGE_VALID_RESULT_MISSING:${JSON.stringify(result)}`)
  }
  const { proxyRequests, assetRequests } = fixture.readRequests()
  if (
    proxyRequests.length !== 1 ||
    assetRequests.length !== 1 ||
    proxyRequests[0].traceId !== assetRequests[0].traceId ||
    proxyRequests[0].contentLength !== assetRequests[0].contentLength ||
    Math.abs(proxyRequests[0].at - assetRequests[0].at) > 1_000 ||
    assetRequests[0].traceId === ''
  ) {
    throw new Error(`DOWNLOAD_HERMES_PROXY_MAPPING_MISSING:${JSON.stringify({ proxyRequests, assetRequests })}`)
  }
  process.stdout.write(`DOWNLOAD_HERMES_PROXY_MAPPING=${JSON.stringify({ proxyRequests, assetRequests })}\n`)
  process.stdout.write(`DOWNLOAD_HERMES_BRIDGE_VALID_RESULT=${JSON.stringify(result)}\n`)
}

export async function verifyAfterMutation({ tempRoot, root }) {
  const result = await invokeDownloadBridge(tempRoot, root)
  if (result.status !== 'rejected' || !result.message.includes('ACTION_NOT_FOUND')) {
    throw new Error(`DOWNLOAD_HERMES_BRIDGE_COUNTERFACTUAL_DID_NOT_FAIL:${JSON.stringify(result)}`)
  }
  process.stdout.write(`DOWNLOAD_HERMES_BRIDGE_HANDLER_REMOVED=${JSON.stringify(result)}\n`)
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
        "window.toolbox.download.start('hermes-macos-arm64').then((started) => { const poll = () => window.toolbox.download.status(started.taskId).then((value) => { if (value.state === 'downloading' || value.state === 'verifying') { setTimeout(poll, 25); return; } const signal = new Image(); signal.src = `/result?status=resolved&taskId=${encodeURIComponent(value.taskId)}&state=${encodeURIComponent(value.state)}&message=${encodeURIComponent(value.message)}&totalBytes=${encodeURIComponent(value.totalBytes)}`; }).catch((error) => { const signal = new Image(); signal.src = `/result?status=rejected&message=${encodeURIComponent(String(error.message))}`; }); poll(); }).catch((error) => { const signal = new Image(); signal.src = `/result?status=rejected&message=${encodeURIComponent(String(error.message))}`; });"
      )
      return
    }
    if (requestUrl.pathname === '/result') {
      resolveResult({
        status: requestUrl.searchParams.get('status'),
        taskId: requestUrl.searchParams.get('taskId') ?? '',
        state: requestUrl.searchParams.get('state') ?? '',
        message: requestUrl.searchParams.get('message') ?? '',
        totalBytes: requestUrl.searchParams.get('totalBytes') ?? ''
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
    throw new Error('DOWNLOAD_HERMES_BRIDGE_PROBE_LISTEN_FAILED')
  }
  const electron = spawn(
    join(root, 'node_modules/.bin/electron'),
    [`--user-data-dir=${join(tempRoot, '.download-bridge-user-data')}`, 'out/main/index.js'],
    {
      cwd: tempRoot,
      env: { ...process.env, ELECTRON_RENDERER_URL: `http://127.0.0.1:${address.port}/index.html` },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  let electronStderr = ''
  electron.stderr.on('data', (chunk) => {
    electronStderr += chunk.toString()
  })
  const timeout = setTimeout(() => rejectResult(new Error(`DOWNLOAD_HERMES_BRIDGE_PROBE_TIMEOUT:${electronStderr}`)), 10_000)
  try {
    return await result
  } finally {
    clearTimeout(timeout)
    const exited = new Promise((resolve) => electron.once('exit', resolve))
    electron.kill()
    await exited
    await new Promise((resolve) => server.close(resolve))
  }
}

function writeFixtureCatalog(tempRoot, assetUrl, expectedBytes, sha256) {
  const catalog = {
    catalogVersion: 'bridge-fixture',
    resources: [
      {
        id: 'hermes-macos-arm64',
        software: 'Hermes',
        platform: 'macos',
        architecture: 'arm64',
        type: 'download',
        officialPageUrl: 'https://official.fixture/desktop',
        assetUrl,
        allowedHosts: ['127.0.0.1'],
        version: 'fixture',
        officialVersionLabel: 'fixture',
        format: 'dmg',
        expectedBytes: String(expectedBytes),
        officialSha256: sha256,
        recordedSha256: sha256,
        identity: null,
        approval: {
          approvedAt: '2026-09-07T00:00:00+08:00',
          approvedBy: 'bridge-fixture',
          sourceBuild: 'fixture',
          scope: '核准这一次本地桥验证下载的安装包'
        }
      }
    ]
  }
  writeFileSync(join(tempRoot, 'resources/catalog.json'), JSON.stringify(catalog))
}

function writeFixtureTunnel(tempRoot, proxyUrl) {
  writeFileSync(
    join(tempRoot, 'app/main/download/tunnel-runtime.ts'),
    `import type { TunnelSnapshot } from './types'\nexport function downloadTunnelSnapshot(): TunnelSnapshot { return { state: 'connected', localProxyUrl: ${JSON.stringify(proxyUrl)} } }\n`
  )
}

async function createDownloadFixture() {
  const root = mkdtempSync(join(tmpdir(), 'laixin-hermes-download-fixture-'))
  const application = join(root, 'Hermes.app')
  const contents = join(application, 'Contents')
  const executable = join(contents, 'MacOS', 'Hermes')
  mkdirSync(dirname(executable), { recursive: true })
  writeFileSync(
    join(contents, 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>fixture.hermes</string><key>CFBundleExecutable</key><string>Hermes</string></dict></plist>'
  )
  copyFileSync('/bin/echo', executable)
  chmodSync(executable, 0o755)
  const dmgPath = join(root, 'Hermes.dmg')
  execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-volname', 'Hermes fixture', '-srcfolder', application, '-format', 'UDZO', dmgPath])
  const body = readFileSync(dmgPath)
  const sha256 = createHash('sha256').update(body).digest('hex')
  const proxyRequests = []
  const assetRequests = []
  const asset = createServer((request, response) => {
    const traceId = String(request.headers['x-toolbox-proxy-id'] ?? '')
    assetRequests.push({ traceId, contentLength: String(body.byteLength), at: Date.now() })
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="Hermes.dmg"',
      'content-length': String(body.byteLength)
    })
    createReadStream(dmgPath).pipe(response)
  })
  await listen(asset)
  const assetAddress = asset.address()
  if (assetAddress === null || typeof assetAddress === 'string') throw new Error('DOWNLOAD_HERMES_ASSET_LISTEN_FAILED')
  const proxy = createServer((request, response) => {
    const target = new URL(request.url ?? '/', 'http://127.0.0.1')
    const traceId = `fixture-${proxyRequests.length + 1}`
    const upstream = httpRequest(target, {
      method: request.method,
      headers: { ...request.headers, 'x-toolbox-proxy-id': traceId }
    }, (upstreamResponse) => {
      const contentLength = String(upstreamResponse.headers['content-length'] ?? '')
      proxyRequests.push({ traceId, contentLength, at: Date.now() })
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })
    upstream.on('error', () => response.destroy())
    request.pipe(upstream)
  })
  await listen(proxy)
  const proxyAddress = proxy.address()
  if (proxyAddress === null || typeof proxyAddress === 'string') throw new Error('DOWNLOAD_HERMES_PROXY_LISTEN_FAILED')
  asset.unref()
  proxy.unref()
  process.on('exit', () => rmSync(root, { recursive: true, force: true }))
  return {
    assetUrl: `http://127.0.0.1:${assetAddress.port}/Hermes.dmg`,
    proxyUrl: `http://127.0.0.1:${proxyAddress.port}`,
    byteLength: statSync(dmgPath).size,
    sha256,
    readRequests: () => ({ proxyRequests: [...proxyRequests], assetRequests: [...assetRequests] })
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
}
