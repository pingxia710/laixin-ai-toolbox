import { mkdtempSync, cpSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { prepareSidecar } from '../scripts/prepare-sidecar.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const tempRoot = mkdtempSync(join(tmpdir(), 'laixin-toolbox-bridge-'))
const evidence = []
const verificationMutation = process.env.TOOLBOX_VERIFY_MUTATION
const variants = await discoverAntiGreenVariants()
const activeVariant = verificationMutation === undefined ? undefined : findVariant(variants, verificationMutation)
const expectedVariantFiles = readExpectedVariantFiles()

if (expectedVariantFiles !== undefined) {
  try {
    assertVariantFiles(expectedVariantFiles, variants)
    process.stdout.write('VERIFY_BRIDGE_VARIANT_DISCOVERY=PASS\n')
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
  process.exit(0)
}

try {
  createTemporaryProject()
  injectExampleModule('alpha')
  injectExampleModule('beta')
  activeVariant?.prepareVerificationProject?.(tempRoot)
  runVerificationBuild(tempRoot)
  if (activeVariant !== undefined) {
    await activeVariant.verifyBeforeMutation?.({ tempRoot, root })
    activeVariant.mutateVerificationProject?.(tempRoot)
    runVerificationBuild(tempRoot)
  }
  assertContains(readOutput(tempRoot), 'alpha.echo', '验证构建缺少 alpha 动作')
  assertContains(readOutput(tempRoot), 'beta.echo', '验证构建缺少 beta 动作')
  assertContains(readOutput(tempRoot), 'connect-src https://laixin.work', '生产构建缺少官网群码清单 CSP')
  evidence.push('验证构建: alpha.echo=命中, beta.echo=命中, production-CSP=laixin-group-entry-only')
  verifySourceGuardContrafactual()
  evidence.push('来源守卫反向探针: 守卫在位=rc:0, 移除守卫=rc:1')
  verifyFixtureListenerLifecycle()
  evidence.push('fixture 状态与监听器: 点击后状态保持, 初挂=1, 卸载后=0, 重挂=1')
  const bridgeResult = await verifyRealElectronBridge()
  evidence.push(`真实 Electron 桥: alpha=${bridgeResult.alpha}, beta=${bridgeResult.beta}`)
  verifyDuplicatePreloadFails()
  evidence.push('重复 preload 命名空间: tsc=拒绝, build=拒绝')
  verifyDuplicatePageFails()
  evidence.push('重复页面 moduleId: build=拒绝')
  verifyCleanCustomerBuild(activeVariant)
  evidence.push('干净客户构建: alpha=零命中, beta=零命中')
  if (verificationMutation === undefined) {
    await verifyAntiGreenVariants(variants)
    evidence.push(`统一入口反向变体: ${variants.length}项均为非零退出`)
  } else {
    await activeVariant.verifyAfterMutation?.({ tempRoot, root })
  }
  process.stdout.write(`${evidence.join('\n')}\nbridge verification build: PASS\n`)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function createTemporaryProject() {
  cpSync(root, tempRoot, {
    recursive: true,
    filter: (source) => {
      const topLevel = relative(root, source).split('/')[0]
      return !['.git', 'node_modules', 'out', 'release'].includes(topLevel)
    }
  })
  symlinkSync(join(root, 'node_modules'), join(tempRoot, 'node_modules'), 'dir')
}

function injectExampleModule(name) {
  const fixture = join(tempRoot, 'tests/fixtures/modules', name)
  cpSync(join(fixture, 'action.ts'), join(tempRoot, 'app/main/actions', `${name}.ts`))
  cpSync(join(fixture, 'api.ts'), join(tempRoot, 'app/preload/api', `${name}.ts`))
  cpSync(join(fixture, 'page.ts'), join(tempRoot, 'app/renderer/src/pages', `${name}.ts`))
}

function runVerificationBuild(projectRoot) {
  run(projectRoot, 'tsc', ['--noEmit'])
  run(projectRoot, 'electron-vite', ['build'])
}

async function verifyRealElectronBridge() {
  const result = await withLoopbackProbe(async (baseUrl) => {
    const electron = spawn(join(root, 'node_modules/.bin/electron'), ['out/main/index.js'], {
      cwd: tempRoot,
      env: { ...process.env, ELECTRON_RENDERER_URL: `${baseUrl}/index.html` },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return electron
  })
  if (result.alpha !== 'alpha' || result.beta !== 'beta') {
    throw new Error(`真实 Electron 桥返回异常:${JSON.stringify(result)}`)
  }
  return result
}

function verifyDuplicatePreloadFails() {
  cpSync(
    join(tempRoot, 'tests/fixtures/duplicate-preload-namespace.ts'),
    join(tempRoot, 'app/preload/api/duplicate.ts')
  )
  expectFailure(tempRoot, 'tsc', ['--noEmit'], 'Subsequent property declarations')
  expectFailure(tempRoot, 'electron-vite', ['build'], 'PRELOAD_NAMESPACE_DUPLICATE')
  rmSync(join(tempRoot, 'app/preload/api/duplicate.ts'))
}

function verifyDuplicatePageFails() {
  cpSync(join(tempRoot, 'app/renderer/src/pages/alpha.ts'), join(tempRoot, 'app/renderer/src/pages/alpha-copy.ts'))
  expectFailure(tempRoot, 'electron-vite', ['build'], 'PAGE_MODULE_DUPLICATE')
  rmSync(join(tempRoot, 'app/renderer/src/pages/alpha-copy.ts'))
}

function verifyCleanCustomerBuild(variant) {
  const cleanRoot = mkdtempSync(join(tmpdir(), 'laixin-toolbox-customer-'))
  try {
    cpSync(root, cleanRoot, {
      recursive: true,
      filter: (source) => {
        const topLevel = relative(root, source).split('/')[0]
        return !['.git', 'node_modules', 'out', 'release'].includes(topLevel)
      }
    })
    // 干净工程里的 sidecar 平台目录是共享源的构建期副本,复制后先补齐再构建。
    prepareSidecar(cleanRoot)
    symlinkSync(join(root, 'node_modules'), join(cleanRoot, 'node_modules'), 'dir')
    variant?.mutateCleanCustomerProject?.(cleanRoot)
    run(cleanRoot, 'electron-vite', ['build'])
    const customerOutput = readOutput(cleanRoot)
    if (customerOutput.includes('alpha.echo') || customerOutput.includes('beta.echo')) {
      throw new Error('干净客户构建仍包含示例模块')
    }
  } finally {
    rmSync(cleanRoot, { recursive: true, force: true })
  }
}

function run(cwd, executable, args) {
  execFileSync(join(root, 'node_modules/.bin', executable), args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe'
  })
}

function verifySourceGuardContrafactual() {
  const baseline = runPackageScript(tempRoot, 'verify:source-guard')
  assertProcessStatus(baseline, 0, '守卫在位的来源探针')
  assertContains(baseline.output, 'SOURCE_GUARD_PROBE=PASS', '守卫在位的来源探针没有通过')
  assertContains(baseline.output, '"actionCalls":1', '守卫在位未限制 actionCalls=1')

  const sourceGuardPath = join(tempRoot, 'app/main/bridge/source-guard.ts')
  const sourceGuard = readFileSync(sourceGuardPath, 'utf8')
  const removedGuard = sourceGuard.replace(
    /[ ]{2}return \(\n[ ]{4}senderFrame !== null &&\n[ ]{4}senderFrame === owner\.mainFrame &&\n[ ]{4}sourceIdentity\(senderFrame\.url\) === sourceIdentity\(entryUrl\)\n[ ]{2}\)/,
    '  return true'
  )
  if (removedGuard === sourceGuard) {
    throw new Error('反向探针未能在临时副本移除来源守卫')
  }
  try {
    writeFileSync(sourceGuardPath, removedGuard)
    const removed = runPackageScript(tempRoot, 'verify:source-guard')
    if (removed.status === 0) {
      throw new Error(`移除来源守卫后探针仍为绿:\n${removed.output}`)
    }
    assertContains(removed.output, 'SOURCE_GUARD_PROBE=FAIL', '移除来源守卫后探针未明确失败')
    assertContains(removed.output, '"actionCalls":4', '移除来源守卫后未观测 actionCalls=4')
    process.stdout.write(`SOURCE_GUARD_IN_PLACE_RAW rc:${baseline.status}\n${baseline.output}`)
    process.stdout.write(`SOURCE_GUARD_REMOVED_RAW rc:${removed.status}\n${removed.output}`)
  } finally {
    writeFileSync(sourceGuardPath, sourceGuard)
  }
}

function verifyFixtureListenerLifecycle() {
  const result = runProcess(tempRoot, 'electron', ['out/main/bridge-probe.js'], {
    TOOLBOX_PAGE_LIFECYCLE_PROBE: '1'
  })
  assertProcessStatus(result, 0, 'fixture 监听器生命周期探针')
  assertContains(result.output, 'PAGE_LIFECYCLE_PROBE=PASS', 'fixture 监听器生命周期探针没有通过')
  assertContains(result.output, 'PAGE_LIFECYCLE_STATE_PRESERVED=PASS', 'fixture 状态未在重挂后保持')
  assertContains(
    result.output,
    '"afterRemount":{"example.alpha":"1","example.beta":"1"}',
    'fixture 监听器计数不符合初挂、卸载、重挂状态'
  )
  process.stdout.write(`FIXTURE_LISTENER_RAW rc:${result.status}\n${result.output}`)
}

async function verifyAntiGreenVariants(variants) {
  for (const { mutation, expectedFailure } of variants) {
    const result = runPackageScript(root, 'verify:bridge', { TOOLBOX_VERIFY_MUTATION: mutation })
    process.stdout.write(`VERIFY_BRIDGE_ANTI_GREEN_VARIANT=${mutation} rc=${String(result.status)}\n`)
    if (result.status === 0 || result.status === null || !result.output.includes(expectedFailure)) {
      throw new Error(`VERIFY_BRIDGE_ANTI_GREEN_FAILED:${mutation}\n${result.output}`)
    }
  }
  verifyVariantDiscoveryCompleteness(variants)
}

async function discoverAntiGreenVariants() {
  const variantsDirectory = join(root, 'tests/bridge-variants')
  const variantFiles = readdirSync(variantsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name)
    .sort()
  return Promise.all(
    variantFiles.map(async (filename) => {
      const mutation = basename(filename, '.mjs')
      const module = await import(pathToFileURL(join(variantsDirectory, filename)).href)
      if (!isBridgeVariant(module)) {
        throw new Error(`VERIFY_BRIDGE_VARIANT_INVALID:${filename}`)
      }
      return { filename, mutation, ...module }
    })
  )
}

function readExpectedVariantFiles() {
  const encoded = process.env.TOOLBOX_VERIFY_EXPECTED_VARIANT_FILES
  if (encoded === undefined) {
    return undefined
  }
  try {
    const parsed = JSON.parse(encoded)
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
      throw new Error('invalid')
    }
    return parsed
  } catch {
    throw new Error('VERIFY_BRIDGE_VARIANT_DISCOVERY_EXPECTATION_INVALID')
  }
}

function assertVariantFiles(expectedFiles, variants) {
  const actualFiles = variants.map((variant) => variant.filename)
  if (
    expectedFiles.length !== actualFiles.length ||
    expectedFiles.some((filename, index) => filename !== actualFiles[index])
  ) {
    throw new Error(
      `VERIFY_BRIDGE_VARIANT_DISCOVERY_INCOMPLETE:expected=${JSON.stringify(expectedFiles)},actual=${JSON.stringify(actualFiles)}`
    )
  }
}

function verifyVariantDiscoveryCompleteness(variants) {
  const withheld = variants.at(-1)
  if (withheld === undefined) {
    throw new Error('VERIFY_BRIDGE_VARIANT_DISCOVERY_EMPTY')
  }
  const variantsDirectory = join(root, 'tests/bridge-variants')
  const variantPath = join(variantsDirectory, withheld.filename)
  const withheldPath = `${variantPath}.withheld`
  renameSync(variantPath, withheldPath)
  try {
    const result = runPackageScript(root, 'verify:bridge', {
      TOOLBOX_VERIFY_EXPECTED_VARIANT_FILES: JSON.stringify(variants.map((variant) => variant.filename))
    })
    process.stdout.write(`VERIFY_BRIDGE_VARIANT_DISCOVERY_PROBE=${withheld.mutation} rc=${String(result.status)}\n`)
    if (result.status === 0 || !result.output.includes('VERIFY_BRIDGE_VARIANT_DISCOVERY_INCOMPLETE')) {
      throw new Error(`VERIFY_BRIDGE_VARIANT_DISCOVERY_FALSE_GREEN:${withheld.mutation}\n${result.output}`)
    }
  } finally {
    renameSync(withheldPath, variantPath)
  }
}

function findVariant(variants, mutation) {
  const variant = variants.find((candidate) => candidate.mutation === mutation)
  if (variant === undefined) {
    throw new Error(`UNKNOWN_VERIFY_BRIDGE_MUTATION:${mutation}`)
  }
  return variant
}

function isBridgeVariant(value) {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('expectedFailure' in value) || typeof value.expectedFailure !== 'string' || value.expectedFailure.length === 0) {
    return false
  }
  const lifecycle = [
    'prepareVerificationProject',
    'mutateVerificationProject',
    'mutateCleanCustomerProject',
    'verifyBeforeMutation',
    'verifyAfterMutation'
  ]
  const mutationLifecycle = ['mutateVerificationProject', 'mutateCleanCustomerProject']
  if (!mutationLifecycle.some((name) => name in value && typeof value[name] === 'function')) {
    return false
  }
  return lifecycle.every((name) => !(name in value) || typeof value[name] === 'function')
}

function runPackageScript(cwd, script, environment = {}) {
  return runProcess(cwd, 'npm', ['run', script], environment)
}

function runProcess(cwd, executable, args, environment = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...environment }
  })
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  }
}

function assertProcessStatus(result, expectedStatus, description) {
  if (result.status !== expectedStatus) {
    throw new Error(`${description}返回码异常: expected=${expectedStatus}, actual=${result.status}\n${result.output}`)
  }
}

function expectFailure(cwd, executable, args, expectedOutput) {
  try {
    run(cwd, executable, args)
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    assertContains(output, expectedOutput, `预期构建拒绝码缺失:${expectedOutput}`)
    return
  }
  throw new Error(`预期构建失败但通过:${expectedOutput}`)
}

function readOutput(projectRoot) {
  return readTree(join(projectRoot, 'out'))
}

function readTree(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? [readTree(path)] : [readFileSync(path, 'utf8')]
    })
    .join('')
}

function assertContains(value, expected, message) {
  if (!value.includes(expected)) {
    throw new Error(message)
  }
}

async function withLoopbackProbe(spawnElectron) {
  let resolveResult
  let rejectResult
  const result = new Promise((resolvePromise, rejectPromise) => {
    resolveResult = resolvePromise
    rejectResult = rejectPromise
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
        "Promise.all([window.toolbox.alpha.echo(), window.toolbox.beta.echo()]).then(([alpha, beta]) => { const signal = new Image(); signal.src = `/result?alpha=${encodeURIComponent(alpha.source)}&beta=${encodeURIComponent(beta.source)}`; document.body.append(signal); });"
      )
      return
    }
    if (requestUrl.pathname === '/result') {
      resolveResult({ alpha: requestUrl.searchParams.get('alpha'), beta: requestUrl.searchParams.get('beta') })
      response.statusCode = 204
      response.end()
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('无法建立本地回环验证服务')
  }
  const electron = await spawnElectron(`http://127.0.0.1:${address.port}`)
  const timeout = setTimeout(() => rejectResult(new Error('真实 Electron 桥验证超时')), 10_000)
  try {
    return await result
  } finally {
    clearTimeout(timeout)
    electron.kill()
    server.close()
  }
}
