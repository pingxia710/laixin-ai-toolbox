import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { displayReleaseVersion } from '../../app/release-version'
import { readUpdateManifest, newerVersion, type UpdateRelease } from '../../app/main/desktop/update-manifest'
import { ToolboxUpdater } from '../../app/main/desktop/updater'
import { updateArchivePaths } from '../../app/main/desktop/zip-paths'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const envelope = (release: UpdateRelease) => {
  const payload = Buffer.from(JSON.stringify(release))
  return JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') })
}
const content = Buffer.from('complete-update-package')
const asset = { url: 'https://updates.example/AI-tools/updates/toolbox.zip', size: content.length,
  sha256: createHash('sha256').update(content).digest('hex'), asarSha256: 'a'.repeat(64) }
const release: UpdateRelease = { version: '0.4.1-unified.13', notes: '后台与更新', assets: { 'darwin-arm64': asset } }
const origin = new URL('https://updates.example/AI-tools/')

describe('更新信任边界', () => {
  it('比较数字版本，unified.13 高于 9；不把旧版当更新', () => {
    expect(newerVersion('0.4.1-unified.13', '0.4.1-unified.9')).toBe(true)
    expect(newerVersion('0.4.1-unified.9', '0.4.1-unified.13')).toBe(false)
    expect(newerVersion('0.4.1', '0.4.1-unified.13')).toBe(true)
    expect(newerVersion('malformed', '0.4.1')).toBe(false)
    expect(displayReleaseVersion('0.4.2')).toBe('V0.42')
    expect(displayReleaseVersion('0.4.1-unified.18')).toBe('0.4.1-unified.18')
  })
  it('只有发布密钥签名的清单和同源更新包才能被接受', () => {
    expect(readUpdateManifest(envelope(release), publicKey, origin, 'darwin-arm64', '0.4.1-unified.12')).toEqual(release)
    const intel = { ...release, assets: { ...release.assets, 'darwin-x64': asset } }
    expect(readUpdateManifest(envelope(intel), publicKey, origin, 'darwin-x64', '0.4.1-unified.12')).toEqual(intel)
    const tampered = JSON.parse(envelope(release)); tampered.payload = Buffer.from(JSON.stringify({ ...release, notes: 'tampered' })).toString('base64')
    expect(() => readUpdateManifest(JSON.stringify(tampered), publicKey, origin, 'darwin-arm64', '0.4.1-unified.12')).toThrow('UPDATE_SIGNATURE_INVALID')
    for (const url of ['https://other.example/AI-tools/updates/toolbox.zip', 'https://laixin.work/updates/toolbox.zip', 'https://updates.example/other/toolbox.zip', 'https://updates.example/AI-tools/updates/../../toolbox.zip']) {
      const changed = { ...release, assets: { 'darwin-arm64': { ...asset, url } } }
      expect(() => readUpdateManifest(envelope(changed), publicKey, origin, 'darwin-arm64', '0.4.1-unified.12')).toThrow('UPDATE_SOURCE_INVALID')
    }
    expect(() => readUpdateManifest(envelope(release), publicKey, origin, 'win32-x64', '0.4.1-unified.12')).toThrow('UPDATE_PLATFORM_UNAVAILABLE')
  })

  it('域名迁移兼容清单仍被旧客户端按旧前缀接受', () => {
    const legacy = { ...release, assets: { 'darwin-arm64': {
      ...asset, url: 'https://laixin.net.cn/AI-tools/updates/toolbox.zip'
    } } }
    expect(readUpdateManifest(envelope(legacy), publicKey, new URL('https://laixin.net.cn/AI-tools/'), 'darwin-arm64', '0.4.1-unified.12')).toEqual(legacy)
  })

  // 2026-09-20 Intel Mac 客户实障(IM-01):线上清单停在 0.5.10(只有 darwin-arm64/win32-x64,
  // 无 darwin-x64),装 0.5.11+ 的 Intel 客户点「检查更新」永远报「暂时无法检查更新」——
  // 资产检查跑在版本比较之前,把「清单没有更新可推」误判成「检查失败」。清单不比已装新
  // (更旧或同版)时直接放行,调用方走既有「已是最新」;清单真有新版时缺平台仍要如实抛(上一条守卫)。
  it('清单不比已装新时缺本平台资产不算检查失败(Intel 客户对线上 0.5.10 清单)', () => {
    const noIntel = { version: '0.5.10', notes: '· 常规修复', assets: { 'darwin-arm64': asset, 'win32-x64': asset } }
    expect(readUpdateManifest(envelope(noIntel), publicKey, origin, 'darwin-x64', '0.5.11')).toEqual(noIntel)
    expect(readUpdateManifest(envelope(noIntel), publicKey, origin, 'darwin-x64', '0.5.10')).toEqual(noIntel)
  })

  // 2026-09-16:国内客户连不上 GitHub(无代理真机实测直接超时),官网单机实测 72.7 KB/s、123MB 要 29 分钟。
  // 故新增国内 CDN 镜像通道。安全上不放任:主机必须来自构建时注入的白名单,路径与扩展名规则与官网源一致,
  // 所以它只能指向同名的那个更新包。⛔ 让清单里随便一个主机都能当下载源。
  it('CDN 镜像只接受白名单主机、且路径规则与官网源一致', () => {
    const hosts = ['dl.laixin.net.cn']
    const good = { ...release, assets: { 'darwin-arm64': { ...asset,
      mirrors: ['https://dl.laixin.net.cn/AI-tools/updates/toolbox.zip'] } } }
    expect(readUpdateManifest(envelope(good), publicKey, origin, 'darwin-arm64', '0.4.1-unified.12',
      'pingxia710/laixin-ai-toolbox', hosts)).toEqual(good)

    // CDN 与 GitHub 可以并存,顺序即优先级(客户端按 [...mirrors, url] 依次尝试)
    const both = { ...release, assets: { 'darwin-arm64': { ...asset, mirrors: [
      'https://dl.laixin.net.cn/AI-tools/updates/toolbox.zip',
      'https://github.com/pingxia710/laixin-ai-toolbox/releases/download/v0.4.1-unified.13/toolbox.zip'] } } }
    expect(readUpdateManifest(envelope(both), publicKey, origin, 'darwin-arm64', '0.4.1-unified.12',
      'pingxia710/laixin-ai-toolbox', hosts)).toEqual(both)

    for (const [why, mirror] of [
      ['主机不在白名单', 'https://evil.example/AI-tools/updates/toolbox.zip'],
      ['白名单主机但路径越界', 'https://dl.laixin.net.cn/somewhere/toolbox.zip'],
      ['白名单主机但扩展名不符', 'https://dl.laixin.net.cn/AI-tools/updates/toolbox.exe'],
      ['明文 http', 'http://dl.laixin.net.cn/AI-tools/updates/toolbox.zip']
    ] as const) {
      const changed = { ...release, assets: { 'darwin-arm64': { ...asset, mirrors: [mirror] } } }
      expect(() => readUpdateManifest(envelope(changed), publicKey, origin, 'darwin-arm64', '0.4.1-unified.12',
        'pingxia710/laixin-ai-toolbox', hosts), why).toThrow('UPDATE_SOURCE_INVALID')
    }

    // 没注入白名单时,CDN 地址一律不认(默认行为与从前一致)
    const noHosts = { ...release, assets: { 'darwin-arm64': { ...asset,
      mirrors: ['https://dl.laixin.net.cn/AI-tools/updates/toolbox.zip'] } } }
    expect(() => readUpdateManifest(envelope(noHosts), publicKey, origin, 'darwin-arm64', '0.4.1-unified.12',
      'pingxia710/laixin-ai-toolbox')).toThrow('UPDATE_SOURCE_INVALID')
  })

  it('GitHub 镜像只接受指定公开仓库当前版本的 Release 文件', () => {
    const mirrored = { ...release, assets: { 'darwin-arm64': { ...asset,
      mirrors: ['https://github.com/pingxia710/laixin-ai-toolbox/releases/download/v0.4.1-unified.13/toolbox.zip'] } } }
    expect(readUpdateManifest(envelope(mirrored), publicKey, origin, 'darwin-arm64', '0.4.1-unified.12',
      'pingxia710/laixin-ai-toolbox')).toEqual(mirrored)

    for (const mirror of [
      'https://evil.example/toolbox.zip',
      'https://github.com/other/laixin-ai-toolbox/releases/download/v0.4.1-unified.13/toolbox.zip',
      'https://github.com/pingxia710/laixin-ai-toolbox/releases/download/v0.4.0/toolbox.zip'
    ]) {
      const changed = { ...release, assets: { 'darwin-arm64': { ...asset, mirrors: [mirror] } } }
      expect(() => readUpdateManifest(envelope(changed), publicKey, origin, 'darwin-arm64', '0.4.1-unified.12',
        'pingxia710/laixin-ai-toolbox')).toThrow('UPDATE_SOURCE_INVALID')
    }
  })
})

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'toolbox-update-test-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  let body = content, feedStatus = 200, redirect = false
  const server = createServer((req, res) => {
    if (req.url === '/AI-tools/updates/latest.json') {
      res.writeHead(feedStatus); res.end(envelope({ ...release, assets: { 'darwin-arm64': { ...asset, url: `${base}updates/toolbox.zip` } } })); return
    }
    if (redirect) { res.writeHead(302, { location: '/elsewhere' }); res.end(); return }
    res.writeHead(200); res.write(body.subarray(0, 7)); res.end(body.subarray(7))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/AI-tools/`
  const quit = vi.fn()
  const updater = new ToolboxUpdater({ version: '0.4.1-unified.12', platform: 'darwin-arm64', origin: base, publicKey,
    directory, executable: '/does-not-exist', helperPath: '/does-not-exist', packaged: false, quit })
  cleanups.push(async () => updater.dispose())
  return { directory, updater, quit, corrupt: () => { body = Buffer.from('tampered-update-package') }, unavailable: () => { feedStatus = 404 }, redirect: () => { redirect = true } }
}

it('实际 HTTP 下载完整校验后才允许重启，开发环境不会替换安装程序', async () => {
  const f = await fixture()
  expect((await f.updater.check()).state).toBe('available')
  expect((await f.updater.download()).state).toBe('ready')
  const folders = await readdir(f.directory)
  expect(await readFile(join(f.directory, folders[0], 'update.zip'))).toEqual(content)
  expect((await f.updater.check()).state).toBe('ready')
  expect((await f.updater.install()).state).toBe('error')
  expect(f.quit).not.toHaveBeenCalled()
})

it.each(['corrupt', 'redirect'] as const)('%s 包不会成为可安装文件，也不会退出旧程序', async (mode) => {
  const f = await fixture(); await f.updater.check(); f[mode]()
  expect((await f.updater.download()).state).toBe('error')
  for (const folder of await readdir(f.directory)) expect(await readdir(join(f.directory, folder))).toEqual([])
  await f.updater.install(); expect(f.quit).not.toHaveBeenCalled()
})

it('尚未发布更新服务时不能误报已是最新版', async () => {
  const f = await fixture(); f.unavailable()
  expect(await f.updater.check()).toMatchObject({ state: 'error', message: '更新服务暂未提供版本信息，请稍后再检查。' })
})

it('官网清单不可用时从 GitHub Release 读取同一份签名清单', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toolbox-update-github-feed-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const githubAsset = 'https://github.com/pingxia710/laixin-ai-toolbox/releases/download/v0.4.1-unified.13/toolbox.zip'
  const mirrored = { ...release, assets: { 'darwin-arm64': { ...asset, mirrors: [githubAsset] } } }
  const seen: string[] = []
  const updateFetch: typeof fetch = async (input) => {
    const url = String(input); seen.push(url)
    if (url === 'https://updates.example/AI-tools/updates/latest.json') return new Response('', { status: 503 })
    if (url === 'https://github.com/pingxia710/laixin-ai-toolbox/releases/latest/download/latest.json') {
      return new Response(envelope(mirrored), { status: 200 })
    }
    return new Response('', { status: 404 })
  }
  const updater = new ToolboxUpdater({ version: '0.4.1-unified.12', platform: 'darwin-arm64', origin: origin.href,
    githubRepository: 'pingxia710/laixin-ai-toolbox', publicKey, directory, executable: '/does-not-exist', helperPath: '/does-not-exist',
    packaged: false, quit: vi.fn(), fetch: updateFetch })
  cleanups.push(async () => updater.dispose())

  expect((await updater.check()).state).toBe('available')
  expect(seen).toContain('https://github.com/pingxia710/laixin-ai-toolbox/releases/latest/download/latest.json')
})

it('官网清单连接卡住时不等到总超时，继续检查 GitHub', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toolbox-update-github-timeout-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const githubAsset = 'https://github.com/pingxia710/laixin-ai-toolbox/releases/download/v0.4.1-unified.13/toolbox.zip'
  const mirrored = { ...release, assets: { 'darwin-arm64': { ...asset, mirrors: [githubAsset] } } }
  const updateFetch: typeof fetch = async (input, init) => {
    if (String(input).includes('updates.example')) {
      return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }
    return new Response(envelope(mirrored), { status: 200 })
  }
  const updater = new ToolboxUpdater({ version: '0.4.1-unified.12', platform: 'darwin-arm64', origin: origin.href,
    githubRepository: 'pingxia710/laixin-ai-toolbox', sourceTimeoutMs: 10, publicKey, directory,
    executable: '/does-not-exist', helperPath: '/does-not-exist', packaged: false, quit: vi.fn(), fetch: updateFetch })
  cleanups.push(async () => updater.dispose())

  expect((await updater.check()).state).toBe('available')
})

it('优先使用 GitHub 镜像；GitHub 失败时自动改走官网并保持完整校验', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toolbox-update-github-asset-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const officialAsset = 'https://updates.example/AI-tools/updates/toolbox.zip'
  const githubAsset = 'https://github.com/pingxia710/laixin-ai-toolbox/releases/download/v0.4.1-unified.13/toolbox.zip'
  const mirrored = { ...release, assets: { 'darwin-arm64': { ...asset, url: officialAsset, mirrors: [githubAsset] } } }
  const seen: string[] = []
  const updateFetch: typeof fetch = async (input) => {
    const url = String(input); seen.push(url)
    if (url.endsWith('/latest.json')) return new Response(envelope(mirrored), { status: 200 })
    if (url === githubAsset) return new Response('', { status: 503 })
    if (url === officialAsset) return new Response(content, { status: 200 })
    return new Response('', { status: 404 })
  }
  const updater = new ToolboxUpdater({ version: '0.4.1-unified.12', platform: 'darwin-arm64', origin: origin.href,
    githubRepository: 'pingxia710/laixin-ai-toolbox', publicKey, directory, executable: '/does-not-exist', helperPath: '/does-not-exist',
    packaged: false, quit: vi.fn(), fetch: updateFetch })
  cleanups.push(async () => updater.dispose())

  expect((await updater.check()).state).toBe('available')
  expect((await updater.download()).state).toBe('ready')
  expect(seen).toContain(officialAsset)
  expect(seen).toContain(githubAsset)
})

it('上一轮更新启动失败会保留原因，不会重开后静默回到重复下载', async () => {
  const f = await fixture()
  await writeFile(join(f.directory, 'result.json'), JSON.stringify({
    version: '0.4.1-unified.13', state: 'error', code: 'UPDATE_STARTUP_UNCONFIRMED'
  }))
  const retryFetch: typeof fetch = async (input) => new Response(String(input).endsWith('latest.json') ? envelope(release) : content, { status: 200 })
  const restored = new ToolboxUpdater({ version: '0.4.1-unified.12', platform: 'darwin-arm64', origin: origin.toString(), publicKey,
    directory: f.directory, executable: '/does-not-exist', helperPath: '/does-not-exist', packaged: false, quit: vi.fn(),
    fetch: retryFetch })
  cleanups.push(async () => restored.dispose())

  expect(restored.status()).toMatchObject({ state: 'error', version: '0.4.1-unified.13', message: expect.stringContaining('新版未能正常启动') })
  expect(await restored.check()).toMatchObject({ state: 'error', version: '0.4.1-unified.13', message: expect.stringContaining('新版未能正常启动') })
  // 失败信息不把用户锁死：明确点“重新下载”仍可重试。
  expect((await restored.download()).state).toBe('ready')
})

it('兼容旧 Windows 助手仅写了失败提示、还没有失败代码的记录', async () => {
  const f = await fixture()
  await writeFile(join(f.directory, 'result.json'), JSON.stringify({
    version: '0.4.1-unified.13', state: 'error', message: '更新未完成，原程序可用。'
  }))
  const restored = new ToolboxUpdater({ version: '0.4.1-unified.12', platform: 'darwin-arm64', origin: origin.toString(), publicKey,
    directory: f.directory, executable: '/does-not-exist', helperPath: '/does-not-exist', packaged: false, quit: vi.fn() })
  cleanups.push(async () => restored.dispose())

  expect(restored.status()).toMatchObject({ state: 'error', version: '0.4.1-unified.13', message: expect.stringContaining('上一次更新未完成') })
})

it('macOS 生成的不带 UTF-8 标志的中文 ZIP 路径仍能正确校验，损坏目录被拒绝', async () => {
  const f = await fixture(), name = Buffer.from('来信AI工具箱统一版.app/Contents/Info.plist')
  const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(header.length + name.length, 12)
  const file = join(f.directory, 'chinese.zip'); await writeFile(file, Buffer.concat([header, name, end]))
  expect(await updateArchivePaths(file)).toEqual([name.toString('utf8')])
  end.writeUInt32LE(0xffffffff, 12); await writeFile(file, Buffer.concat([header, name, end]))
  await expect(updateArchivePaths(file)).rejects.toThrow('UPDATE_ARCHIVE_INVALID')
})

it('新程序启动失败时还原原文件，更新助手自己的进程不阻止回滚', async () => {
  const f = await fixture(), target = join(f.directory, 'installed.app'), staged = join(f.directory, 'staged.app')
  const inside = 'Contents/Resources/app.asar'
  for (const app of [target, staged]) await mkdir(join(app, 'Contents/Resources'), { recursive: true })
  await writeFile(join(target, inside), 'old-version'); await writeFile(join(staged, inside), 'new-version')
  const installer = join(f.directory, 'asset.zip'); await writeFile(installer, 'asset')
  const exited = spawn(process.execPath, ['-e', 'process.exit(0)']); await new Promise((resolve) => exited.once('close', resolve))
  const job = { parentPid: exited.pid, platform: 'mac', target, staged, installer, executable: join(target, 'Contents/MacOS/Toolbox'),
    userData: f.directory, version: '0.4.1-unified.13', asarSha256: createHash('sha256').update('new-version').digest('hex'),
    assetSha256: createHash('sha256').update('asset').digest('hex'), assetSize: 5,
    result: join(f.directory, 'result.json'), ready: join(f.directory, 'ready'), acknowledgement: join(f.directory, 'ack.json') }
  const commands = vi.fn(async (command: string, args: string[]) => {
    if (command === '/usr/bin/ditto') await cp(args[0], args[1], { recursive: true })
    if (command === '/usr/bin/open') throw new Error('TEST_NEW_APP_CANNOT_START')
    return { stdout: command === '/bin/ps' ? `${process.pid} ${job.executable} helper.cjs` : '' }
  })
  const helper = createRequire(import.meta.url)('../../resources/update-helper.cjs') as { run(job: object, commands: (command: string, args: string[]) => Promise<{ stdout: string }>): Promise<void> }
  await helper.run(job, commands)
  expect(await readFile(join(target, inside), 'utf8')).toBe('old-version')
  expect(JSON.parse(await readFile(job.result, 'utf8'))).toMatchObject({ state: 'error', stage: 'launch' })
  expect(commands.mock.calls.filter(([name]) => name === '/usr/bin/open')).toHaveLength(2)
})


describe('更新成功信息随任务交给新版', () => {
  it('安装把「从哪版升上来、这版改了什么」写进 pending.json,新版启动才有的说', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'toolbox-update-pending-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const winContent = Buffer.from('win-update-package')
    const winRelease: UpdateRelease = { version: '0.5.8', notes: '· 网络修复\n· 模型 API',
      assets: { 'win32-x64': { url: 'https://updates.example/AI-tools/updates/toolbox.exe', size: winContent.length,
        sha256: createHash('sha256').update(winContent).digest('hex'), asarSha256: 'a'.repeat(64) } } }
    const fetchStub = (async (url: unknown) => new Response(String(url).endsWith('latest.json') ? envelope(winRelease) : winContent, { status: 200 })) as unknown as typeof fetch
    const installed = join(directory, 'installed')
    await mkdir(installed, { recursive: true })
    const updater = new ToolboxUpdater({ version: '0.5.7', platform: 'win32-x64', origin: 'https://updates.example/AI-tools/',
      publicKey, directory, executable: join(installed, '来信AI工具箱统一版.exe'), helperPath: 'C:\\x\\update-helper.ps1',
      packaged: true, quit: vi.fn(), fetch: fetchStub })
    cleanups.push(async () => updater.dispose())
    expect(await updater.check()).toMatchObject({ state: 'available', version: '0.5.8' })
    expect(await updater.download()).toMatchObject({ state: 'ready' })
    // 本机没有 powershell.exe ⇒ 安装在 spawn 处失败走既有还原路;pending.json 在那之前已写好,
    // 这里只认「成功信息必须随任务交给新版」。
    await updater.install()
    expect(JSON.parse(await readFile(join(directory, 'pending.json'), 'utf8'))).toMatchObject({
      version: '0.5.8', previous: '0.5.7', notes: '· 网络修复\n· 模型 API', requireConnected: false })
  })
})

it('助手用 PS5.1 写的带 BOM 回执也读得出来,⛔ 让一个 BOM 把失败记录变成不存在', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toolbox-update-bom-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const receipt = JSON.stringify({ version: '0.4.1-unified.13', state: 'error', code: 'UPDATE_STARTUP_UNCONFIRMED' })
  await writeFile(join(directory, 'result.json'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(receipt, 'utf8')]))
  const restored = new ToolboxUpdater({ version: '0.4.1-unified.12', platform: 'darwin-arm64', origin: 'https://updates.example/AI-tools/',
    publicKey, directory, executable: '/does-not-exist', helperPath: '/does-not-exist', packaged: false, quit: vi.fn() })
  cleanups.push(async () => restored.dispose())
  expect(restored.status()).toMatchObject({ state: 'error', version: '0.4.1-unified.13', message: expect.stringContaining('新版未能正常启动') })
})

// 2026-09-16 客户真机故障的守门测试(点完更新又回到重新下载):原先这里只做源码字面匹配,
// 常量换个写法就红、真把等待改坏反而绿。现在换成行为测试:假时钟+假助手,钉住三格——
// ① 29 秒才 ready 要放行(5 秒时代就死在这一格);② 超过 30 秒没 ready 要判死,且文案区分
// 「更新程序没能启动」;③ 立即 ready 不白等。时钟/等待由 updater 注入出来,生产走默认值。
describe('助手 ready 等待(行为:29 秒放行 / 30 秒判死 / 立即不白等)', () => {
  function fakeClock() {
    const start = 1_000_000
    let now = start
    let hook: (() => Promise<void>) | undefined
    return {
      now: () => now,
      wait: async (ms: number) => { now += ms; if (hook) await hook() },
      /** 从起点 msFromStart 毫秒后(按假时钟)执行一次 action,模拟助手此刻才写出 ready。 */
      at(msFromStart: number, action: () => Promise<void>) {
        const fire = start + msFromStart
        hook = async () => { if (now >= fire) { hook = undefined; await action() } }
      },
      elapsed: () => now - start
    }
  }

  async function readyFixture(clock: ReturnType<typeof fakeClock>) {
    const directory = await mkdtemp(join(tmpdir(), 'toolbox-update-ready-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const winContent = Buffer.from('win-update-package')
    const winRelease: UpdateRelease = { version: '0.5.8', notes: '助手等待',
      assets: { 'win32-x64': { url: 'https://updates.example/AI-tools/updates/toolbox.exe', size: winContent.length,
        sha256: createHash('sha256').update(winContent).digest('hex'), asarSha256: 'a'.repeat(64) } } }
    const fetchStub = (async (url: unknown) => new Response(String(url).endsWith('latest.json') ? envelope(winRelease) : winContent, { status: 200 })) as unknown as typeof fetch
    const installed = join(directory, 'installed')
    await mkdir(installed, { recursive: true })
    // 真 Windows 上助手由系统目录里的 cmd.exe 起(绝对路径,见 update-helper-launch.ts),本机没有;
    // 注入一个只报「起来了」的假 spawn,只为真正跑进 ready 等待循环。ready 何时出现完全由假时钟决定,不吃真实等待。
    const spawned = ((): ChildProcess => {
      const child = new EventEmitter() as ChildProcess
      child.unref = () => undefined
      setImmediate(() => child.emit('spawn'))
      return child
    }) as unknown as typeof spawn
    const quit = vi.fn()
    const updater = new ToolboxUpdater({ version: '0.5.7', platform: 'win32-x64', origin: 'https://updates.example/AI-tools/',
      publicKey, directory, executable: join(installed, '来信AI工具箱统一版.exe'), helperPath: 'C:\\x\\update-helper.ps1',
      packaged: true, quit, fetch: fetchStub, now: clock.now, wait: clock.wait, spawn: spawned })
    cleanups.push(async () => updater.dispose())
    expect(await updater.check()).toMatchObject({ state: 'available' })
    expect(await updater.download()).toMatchObject({ state: 'ready' })
    const folder = (await readdir(directory)).find((name) => name.startsWith('download-'))
    if (!folder) throw new Error('夹具:下载目录不存在')
    return { updater, quit, ready: join(directory, folder, 'helper-ready') }
  }

  it('助手 29 秒才 ready → 继续更新不判失败(5 秒时代这一格被误杀)', async () => {
    const clock = fakeClock()
    const f = await readyFixture(clock)
    clock.at(29_000, () => writeFile(f.ready, ''))
    await f.updater.install()
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledTimes(1))
    expect(clock.elapsed()).toBeLessThan(30_000)
    expect(f.updater.status()).toMatchObject({ state: 'installing' })
    expect(f.updater.status().message).not.toContain('更新程序没能启动')
  })

  it('超过 30 秒还没 ready → 判失败,文案区分「更新程序没能启动」', async () => {
    const clock = fakeClock()
    const f = await readyFixture(clock)
    await f.updater.install()
    expect(f.quit).not.toHaveBeenCalled()
    // 下界钉「不许提前放弃」(5 秒时代死在这),上界钉「也不许拖到远超 30 秒才放弃」。
    expect(clock.elapsed()).toBeGreaterThanOrEqual(30_000)
    expect(clock.elapsed()).toBeLessThanOrEqual(31_000)
    expect(f.updater.status()).toMatchObject({ state: 'error', message: expect.stringContaining('更新程序没能启动') })
  })

  it('助手立即 ready → 第一次轮询就放行,不白等', async () => {
    const clock = fakeClock()
    const f = await readyFixture(clock)
    clock.at(0, () => writeFile(f.ready, ''))
    await f.updater.install()
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledTimes(1))
    expect(clock.elapsed()).toBeLessThanOrEqual(100)
    expect(f.updater.status().state).toBe('installing')
  })
})
