import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import type { UpdateRelease } from '../../app/main/desktop/update-manifest'
import { helperLaunch } from '../../app/main/desktop/update-helper-launch'
import { ToolboxUpdater } from '../../app/main/desktop/updater'

// 2026-09-17 0.5.10→0.5.11 真机故障的守门测试:Windows 客户点「更新并重启」,助手进程约 1 秒即退、脚本一行没跑,
// 30 秒后界面报「更新程序没能启动」。本机没有 Windows,这里用一张**真机对照得出的事实表**当进程模型
// (Win11 26200,交互会话,默认终端取 Windows Terminal / 控制台主机 / 让系统决定 三种结果一致;原始输出见
// tasks/UP-01-更新器启动-交付报告-20260917.md)。⛔ 凭想象往表里加行:没在真机上跑过的写法一律按「不执行」算,宁可红。
// 表只是把故障形状搬进单元层;「这种写法在真 Windows 上到底行不行」只有真机端到端(旧版点更新并重启 → 升上新版)说了算,
// 两边各管一段。
interface Outcome { executes: boolean; survivesParent: boolean; visibleWindow: boolean }
const dead: Outcome = { executes: false, survivesParent: false, visibleWindow: false }
function windowsOutcome(command: string, args: readonly string[], options: SpawnOptions): Outcome {
  const program = win32.basename(command).toLowerCase()
  const line = args.join(' ')
  if (program === 'powershell.exe') return options.detached ? dead // 无控制台:进程起得来,脚本不执行
    : { executes: true, survivesParent: false, visibleWindow: false } // 执行,但主进程一退被作业对象一起收掉
  if (program === 'cmd.exe' && /\bstart "" \/min /.test(line) && options.detached) return { executes: true, survivesParent: true, visibleWindow: true }
  if (program === 'cmd.exe' && /\bstart "" \/b /.test(line)) return { executes: true, survivesParent: true, visibleWindow: options.detached === true }
  return dead
}
const originalLaunch = (helperPath: string, jobPath: string) => ({ command: 'powershell.exe',
  args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-JobPath', jobPath],
  options: { detached: true, windowsHide: true, stdio: 'ignore' } as SpawnOptions })

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const envelope = (release: UpdateRelease) => {
  const payload = Buffer.from(JSON.stringify(release))
  return JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') })
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** 假 spawn:按事实表决定「助手有没有执行」——执行了才写 ready(真助手第 12 行干的事)。
 *  rewrite 给反向对照用:不管更新器想怎么起,一律换成原写法。 */
function windowsSpawn(rewrite?: (jobPath: string) => ReturnType<typeof originalLaunch>) {
  const launches: Array<{ command: string; args: readonly string[]; options: SpawnOptions; outcome: Outcome }> = []
  const fake = ((command: string, args: readonly string[], options: SpawnOptions) => {
    const asked = { command, args, options }
    const jobPath = String(options.env?.LAIXIN_UPDATE_JOB ?? args[args.indexOf('-JobPath') + 1])
    const used = rewrite ? rewrite(jobPath) : asked
    const outcome = windowsOutcome(used.command, used.args, used.options)
    launches.push({ ...used, outcome })
    const child = new EventEmitter() as ChildProcess
    child.unref = () => undefined
    setImmediate(() => { child.emit('spawn'); if (outcome.executes) void writeFile(join(dirname(jobPath), 'helper-ready'), 'ready') })
    return child
  }) as unknown as typeof spawn
  return { fake, launches }
}

async function readyToInstall(fakeSpawn: typeof spawn) {
  // 目录名故意带中文、空格和 cmd 元字符:客户的 userData 就在「来信AI工具箱统一版」下,Windows 用户名还能带 & ( ) %。
  const directory = join(await mkdtemp(join(tmpdir(), 'toolbox-update-launch-')), '来信 R&D (测试) 100%', 'updates')
  await mkdir(directory, { recursive: true })
  cleanups.push(() => rm(dirname(dirname(directory)), { recursive: true, force: true }))
  const content = Buffer.from('win-update-package')
  const release: UpdateRelease = { version: '0.5.12', notes: '更新器启动', assets: { 'win32-x64': {
    url: 'https://updates.example/AI-tools/updates/toolbox.exe', size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'), asarSha256: 'a'.repeat(64) } } }
  const fetchStub = (async (url: unknown) => new Response(String(url).endsWith('latest.json') ? envelope(release) : content, { status: 200 })) as unknown as typeof fetch
  const installed = join(dirname(directory), 'installed')
  await mkdir(installed, { recursive: true })
  let now = 0
  const quit = vi.fn()
  const updater = new ToolboxUpdater({ version: '0.5.11', platform: 'win32-x64', origin: 'https://updates.example/AI-tools/', publicKey,
    directory, executable: join(installed, '来信AI工具箱统一版.exe'), helperPath: 'C:\\Users\\R&D\\AppData\\Local\\Programs\\laixin-ai-toolbox\\resources\\update-helper.ps1',
    packaged: true, quit, fetch: fetchStub, spawn: fakeSpawn, now: () => now,
    // 假时钟每次等待先让出一轮事件循环,假助手的 ready 才落得了盘;不吃真实 30 秒。
    wait: async (ms) => { now += ms; await new Promise((resolve) => setImmediate(resolve)) } })
  cleanups.push(async () => updater.dispose())
  expect(await updater.check()).toMatchObject({ state: 'available' })
  expect(await updater.download()).toMatchObject({ state: 'ready' })
  const folder = (await readdir(directory)).find((name) => name.startsWith('download-'))
  if (!folder) throw new Error('夹具:下载目录不存在')
  return { updater, quit, jobPath: join(directory, folder, 'job.json') }
}

describe('Windows 起更新助手(0.5.10→0.5.11 真机:助手没执行 → 「更新程序没能启动」)', () => {
  it('点「更新并重启」→ 助手真的执行并写出 ready、主进程退出后还活着、客户看不到窗口', async () => {
    const { fake, launches } = windowsSpawn()
    const f = await readyToInstall(fake)
    await f.updater.install()
    expect(launches).toHaveLength(1)
    expect(launches[0].outcome).toEqual({ executes: true, survivesParent: true, visibleWindow: false })
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledTimes(1))
    expect(f.updater.status()).toMatchObject({ state: 'installing' })
    // 助手拿到的就是更新器写出的那份 job,而且路径是从环境变量走的(带 & % 中文的目录没进命令行)。
    expect(launches[0].options.env?.LAIXIN_UPDATE_JOB).toBe(f.jobPath)
    expect(launches[0].args.join(' ')).not.toContain('R&D')
  })

  it('反向对照:同一套夹具换回 v0.4.8~0.5.11 的原写法 → 助手不执行,30 秒判死、不退出、文案是「更新程序没能启动」', async () => {
    const { fake, launches } = windowsSpawn((jobPath) => originalLaunch('C:\\x\\update-helper.ps1', jobPath))
    const f = await readyToInstall(fake)
    await f.updater.install()
    expect(launches[0].outcome.executes).toBe(false)
    expect(f.quit).not.toHaveBeenCalled()
    expect(f.updater.status()).toMatchObject({ state: 'error', message: expect.stringContaining('更新程序没能启动') })
  })

  it('去掉 detached 直接起 PowerShell 也不行:会执行,但主进程一退就被一起收掉(换不了文件)', () => {
    const launch = originalLaunch('C:\\x\\update-helper.ps1', 'C:\\x\\job.json')
    expect(windowsOutcome(launch.command, launch.args, { ...launch.options, detached: false })).toMatchObject({ executes: true, survivesParent: false })
  })
})

describe('helperLaunch 写法', () => {
  const helper = 'C:\\Users\\R&D (测试) 100%\\AppData\\Local\\Programs\\laixin-ai-toolbox\\resources\\update-helper.ps1'
  const job = 'C:\\Users\\R&D (测试) 100%\\AppData\\Roaming\\来信AI工具箱统一版\\updates\\download-a1\\job.json'

  it('Windows:非 detached 的 cmd + start /b;路径只走环境变量;系统程序用绝对路径', () => {
    const launch = helperLaunch('win', 'C:\\app\\来信AI工具箱统一版.exe', helper, job, { SystemRoot: 'D:\\WinNT', KEEP: '1' })
    expect(launch.command).toBe('D:\\WinNT\\System32\\cmd.exe')
    expect(launch.args).toEqual(['/d /v:off /s /c "start "" /b "%LAIXIN_UPDATE_POWERSHELL%" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%LAIXIN_UPDATE_HELPER%" -JobPath "%LAIXIN_UPDATE_JOB%""'])
    expect(launch.options).toMatchObject({ detached: false, windowsHide: true, stdio: 'ignore', windowsVerbatimArguments: true })
    expect(launch.options.env).toEqual({ SystemRoot: 'D:\\WinNT', KEEP: '1', LAIXIN_UPDATE_HELPER: helper, LAIXIN_UPDATE_JOB: job,
      LAIXIN_UPDATE_POWERSHELL: 'D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })
  })

  it('Windows:环境里没有 SystemRoot 也落到 C:\\Windows,⛔ 退回靠 PATH 找', () => {
    expect(helperLaunch('win', 'x', helper, job, {}).command).toBe('C:\\Windows\\System32\\cmd.exe')
  })

  it('Mac 不变:主程序当 node 跑 .cjs 助手,detached', () => {
    expect(helperLaunch('mac', '/Applications/x.app/Contents/MacOS/x', '/r/update-helper.cjs', '/u/job.json', { KEEP: '1' })).toEqual({
      command: '/Applications/x.app/Contents/MacOS/x', args: ['/r/update-helper.cjs', '/u/job.json'],
      options: { env: { KEEP: '1', ELECTRON_RUN_AS_NODE: '1' }, detached: true, windowsHide: true, stdio: 'ignore' } })
  })
})
