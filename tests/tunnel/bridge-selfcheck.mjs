// 通道 sidecar-mac 片 · 接桥自证自持探针(本片一个文件,不碰 tests/verify-bridge-build.mjs)。
//
// 由来(派工方 2026-09-06 23:57 追加裁定):verify-bridge-build.mjs 的 expectedFailures 反向变体表
// 由 A 轨单写者改成「按 tests/bridge-variants/*.mjs 目录自动发现」并单独合入 main;该片合入后,
// 本片只需新增 tests/bridge-variants/<本片名>.mjs —— 届时内容 = 本文件的 TUNNEL_VARIANTS 与
// verifyTunnelBridge,原样搬移即可(本文件保留做单元自跑)。
//
// 自跑:node tests/tunnel/bridge-selfcheck.mjs(临时工程副本构建 + 真实 Electron + 回环探针 +
// 三个反向变体逐一变红)。退出码非零 = 失败。
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

// 反向变体定义(即将搬入 tests/bridge-variants/ 的就是这张表 + verifyTunnelBridge)
export const TUNNEL_VARIANTS = [
  {
    id: 'tunnel-handler-missing',
    expectFailure: '通道接桥自证',
    mutate(tempRoot) {
      replaceFileContent(
        join(tempRoot, 'app/main/actions/tunnel.ts'),
        "name: 'tunnel.status'",
        "name: 'tunnel.absent'"
      )
    }
  },
  {
    id: 'tunnel-bridge-removed',
    expectFailure: '通道接桥自证',
    mutate(tempRoot) {
      replaceFileContent(
        join(tempRoot, 'app/preload/api/tunnel.ts'),
        "namespace = 'tunnel'",
        "namespace = 'tunnelabsent'"
      )
    }
  },
  {
    id: 'tunnel-extra-resources',
    expectFailure: 'package.json 缺 sidecar/mac extraResources',
    mutate(tempRoot) {
      replaceFileContent(
        join(tempRoot, 'package.json'),
        '"from": "sidecar/mac/"',
        '"from": "sidecar-absent/"'
      )
    }
  }
]

function replaceFileContent(path, expected, replacement) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(expected)) {
    throw new Error(`SELFCHECK_MUTATION_TARGET_MISSING:${path}`)
  }
  writeFileSync(path, source.replace(expected, replacement))
}

function createTempProject() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'laixin-toolbox-tunnel-selfcheck-'))
  cpSync(root, tempRoot, {
    recursive: true,
    filter: (source) => {
      const topLevel = relative(root, source).split('/')[0]
      return !['.git', 'node_modules', 'out', 'release'].includes(topLevel)
    }
  })
  symlinkSync(join(root, 'node_modules'), join(tempRoot, 'node_modules'), 'dir')
  return tempRoot
}

function buildProject(tempRoot) {
  execFileSync(join(root, 'node_modules/.bin', 'electron-vite'), ['build'], {
    cwd: tempRoot,
    encoding: 'utf8',
    stdio: 'pipe'
  })
}

// 原始探测:返回 { state, source, pending } 或 { error },不自行断言(供 verifyTunnelBridge 与
// tests/bridge-variants/tunnel-bridge.mjs 的正/反两向复用)。
export async function probeTunnelStatus(tempRoot) {
  const tunnelDataDir = mkdtempSync(join(tmpdir(), 'laixin-toolbox-tunnel-data-'))
  try {
    return await withTunnelProbe(tempRoot, tunnelDataDir)
  } finally {
    rmSync(tunnelDataDir, { recursive: true, force: true })
  }
}

// 正向:真实 Electron 起产品主进程,回环页面经 window.toolbox.tunnel.status() 调到本片 handler,
// 拿到桥 schema 校验过的返回(桥对不合 schema 的返回会直接拒,探针收不到结果)。
export async function verifyTunnelBridge(tempRoot) {
  const result = await probeTunnelStatus(tempRoot)
  if (result.error !== undefined) {
    throw new Error(`通道接桥自证错误:${result.error}`)
  }
  if (result.state !== '未配置' || result.source !== '' || result.pending !== 'false') {
    throw new Error(`通道接桥自证失败:${JSON.stringify(result)}`)
  }
  return result
}

function withTunnelProbe(tempRoot, tunnelDataDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    let electron
    let settled = false
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
          "try { window.toolbox.tunnel.status().then((s) => { const signal = new Image(); signal.src = `/result?state=${encodeURIComponent(s.state)}&source=${encodeURIComponent(s.source)}&pending=${s.pendingAvailable}`; document.body.append(signal); }).catch((error) => { const signal = new Image(); signal.src = `/error?message=${encodeURIComponent(String(error))}`; document.body.append(signal); }); } catch (error) { const signal = new Image(); signal.src = `/error?message=${encodeURIComponent(String(error))}`; document.body.append(signal); }"
        )
        return
      }
      if (requestUrl.pathname === '/result') {
        settle(resolvePromise, {
          state: requestUrl.searchParams.get('state'),
          source: requestUrl.searchParams.get('source'),
          pending: requestUrl.searchParams.get('pending')
        })
        response.statusCode = 204
        response.end()
        return
      }
      if (requestUrl.pathname === '/error') {
        settle(resolvePromise, { error: requestUrl.searchParams.get('message') ?? '未知' })
        response.statusCode = 204
        response.end()
        return
      }
      response.statusCode = 404
      response.end()
    })
    const timeout = setTimeout(() => settle(rejectPromise, new Error('通道接桥自证超时')), 15_000)
    function settle(settledFn, value) {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      electron?.kill()
      server.close()
      settledFn(value)
    }
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        settle(rejectPromise, new Error('通道接桥自证无法建立回环服务'))
        return
      }
      electron = spawn(join(root, 'node_modules/.bin/electron'), ['out/main/index.js'], {
        cwd: tempRoot,
        env: {
          ...process.env,
          ELECTRON_RENDERER_URL: `http://127.0.0.1:${address.port}/index.html`,
          TOOLBOX_TUNNEL_DATA_DIR: tunnelDataDir
        },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    })
  })
}

function assertTunnelExtraResources(tempRoot) {
  const packageJson = JSON.parse(readFileSync(join(tempRoot, 'package.json'), 'utf8'))
  const extra = packageJson.build?.extraResources
  const hit =
    Array.isArray(extra) &&
    extra.some((entry) => entry.from === 'sidecar/mac/' && entry.to === 'sidecar/mac/')
  if (!hit) {
    throw new Error('package.json 缺 sidecar/mac extraResources')
  }
}

async function runOnce(variant) {
  const tempRoot = createTempProject()
  try {
    variant?.mutate(tempRoot)
    buildProject(tempRoot)
    assertTunnelExtraResources(tempRoot)
    const result = await verifyTunnelBridge(tempRoot)
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function main() {
  const baseline = await runOnce(undefined)
  if (!baseline.ok) {
    process.stderr.write(`通道接桥自证基线失败:${baseline.error}\n`)
    process.exit(1)
  }
  process.stdout.write(
    `通道接桥自证: window.toolbox.tunnel.status → state=${baseline.result.state}, source='${baseline.result.source}'\n`
  )
  for (const variant of TUNNEL_VARIANTS) {
    const outcome = await runOnce(variant)
    const failed = !outcome.ok && (outcome.error ?? '').includes(variant.expectFailure)
    process.stdout.write(
      `TUNNEL_SELFCHECK_VARIANT=${variant.id} ${failed ? 'rc=1(如期变红)' : 'rc=0(未变红!)'}\n`
    )
    if (!failed) {
      process.stderr.write(`反向变体未变红:${variant.id}\n`)
      process.exit(1)
    }
  }
  process.stdout.write('tunnel bridge selfcheck: PASS\n')
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  })
}
