import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
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
    const tampered = JSON.parse(envelope(release)); tampered.payload = Buffer.from(JSON.stringify({ ...release, notes: 'tampered' })).toString('base64')
    expect(() => readUpdateManifest(JSON.stringify(tampered), publicKey, origin, 'darwin-arm64', '0.4.1-unified.12')).toThrow('UPDATE_SIGNATURE_INVALID')
    for (const url of ['https://other.example/AI-tools/updates/toolbox.zip', 'https://updates.example/other/toolbox.zip', 'https://updates.example/AI-tools/updates/../../toolbox.zip']) {
      const changed = { ...release, assets: { 'darwin-arm64': { ...asset, url } } }
      expect(() => readUpdateManifest(envelope(changed), publicKey, origin, 'darwin-arm64', '0.4.1-unified.12')).toThrow('UPDATE_SOURCE_INVALID')
    }
    expect(() => readUpdateManifest(envelope(release), publicKey, origin, 'win32-x64', '0.4.1-unified.12')).toThrow('UPDATE_PLATFORM_UNAVAILABLE')
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
