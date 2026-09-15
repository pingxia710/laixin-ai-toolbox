// 更新时的常驻交接（0.5.0 · 窗口 A）。
// 客户感受那一条：更新之后网络照常，不会因为换了程序就连不上。
// 三件事在这里定死：
//   1) 常驻守护是拿主程序当 node 跑的，命令行前缀和主程序一模一样 —— ⛔ 被更新助手当成「应用又被打开了」，
//      否则装了常驻之后 mac 根本更新不了（永远停在 UPDATE_APP_REOPENED）；
//   2) 换 bundle 前先把常驻停掉，停之前先记下「客户本来是连着的」，新版起来才会接着连；
//   3) Windows 卸载钩子的四步顺序，以及「升级 ⛔ 删登录任务」。
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { residentHandoffFields } from '../../app/main/desktop/updater'
import { RESIDENT_LABEL } from '../../app/main/tunnel/platform/resident'

interface UpdateHelper {
  run(job: object, commands: (command: string, args: string[], options?: object) => Promise<{ stdout: string }>): Promise<void>
}
const helper = createRequire(import.meta.url)('../../resources/update-helper.cjs') as UpdateHelper

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const INSIDE = 'Contents/Resources/app.asar'

async function macJob(options: { intent?: string; tunnelResume?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'toolbox-resident-handoff-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const target = join(directory, 'installed.app')
  const staged = join(directory, 'staged.app')
  for (const app of [target, staged]) await mkdir(join(app, 'Contents/Resources'), { recursive: true })
  await writeFile(join(target, INSIDE), 'old-version')
  await writeFile(join(staged, INSIDE), 'new-version')
  const installer = join(directory, 'asset.zip')
  await writeFile(installer, 'asset')
  const tunnelDataDir = join(directory, 'tunnel')
  await mkdir(tunnelDataDir, { recursive: true })
  if (options.intent !== undefined) {
    await writeFile(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: options.intent, updatedAt: 1 }))
  }
  // 父进程必须是真的已经退了：助手会等它退出才动手。
  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await new Promise((resolve) => exited.once('close', resolve))
  const job = {
    parentPid: exited.pid, platform: 'mac', target, staged, installer,
    executable: join(target, 'Contents/MacOS/Toolbox'), userData: directory,
    tunnelDataDir, residentLabel: RESIDENT_LABEL, tunnelResume: options.tunnelResume === true,
    version: '0.5.0', asarSha256: createHash('sha256').update('new-version').digest('hex'),
    assetSha256: createHash('sha256').update('asset').digest('hex'), assetSize: 5,
    result: join(directory, 'result.json'), ready: join(directory, 'ready'), acknowledgement: join(directory, 'ack.json')
  }
  return { directory, target, job, tunnelDataDir }
}

/** ps 输出里的常驻守护那一行：主程序当 node 跑 sidecar 里的 .mjs。 */
function residentDaemonLine(job: { executable: string; target: string }): string {
  return `4321 ${job.executable} ${join(job.target, 'Contents/Resources/sidecar/mac/tunnel-daemon.mjs')} start --data-dir /x/tunnel --resident 1`
}

function commandsFor(job: { acknowledgement: string }, psLines: string[]) {
  return vi.fn(async (command: string, args: string[]) => {
    if (command === '/usr/bin/ditto') await cp(args[0], args[1], { recursive: true })
    if (command === '/usr/bin/open') await writeFile(job.acknowledgement, JSON.stringify({ version: '0.5.0', pid: 1 }))
    return { stdout: command === '/bin/ps' ? `${psLines.join('\n')}\n` : '' }
  })
}

it('常驻守护还活着时更新照样能做完（⛔ 把它当成「应用又被打开了」）', async () => {
  const { target, job, tunnelDataDir } = await macJob({ intent: 'connected', tunnelResume: true })
  const commands = commandsFor(job, [residentDaemonLine(job)])

  await helper.run(job, commands)

  expect(JSON.parse(await readFile(job.result, 'utf8'))).toMatchObject({ state: 'complete', version: '0.5.0' })
  expect(await readFile(join(target, INSIDE), 'utf8')).toBe('new-version')
  // 换 bundle 前先停常驻：bootout 打在当前用户的 GUI 域上，标签与主进程装的那一套一致
  const bootout = commands.mock.calls.find(([name]) => name === '/usr/bin/launchctl')
  expect(bootout?.[1]).toEqual(['bootout', `gui/${String(process.getuid ? process.getuid() : 0)}/${RESIDENT_LABEL}`])
  // 停之前先记下「客户本来是连着的」，否则守护按正常关停把意图写成 shutdown，新版起来就不再连
  expect(existsSync(join(tunnelDataDir, 'resume-on-launch'))).toBe(true)
  // 顺序：先停常驻，再查「应用是不是又被打开了」
  const order = commands.mock.calls.map(([name]) => name)
  expect(order.indexOf('/usr/bin/launchctl')).toBeLessThan(order.lastIndexOf('/bin/ps'))
})

it('真的把应用又打开了，还是要拦下来（这条检查 ⛔ 被上一条顺手废掉）', async () => {
  const { job } = await macJob({ intent: 'connected' })
  const commands = commandsFor(job, [`4322 ${job.executable} --user-data-dir=/x`])

  await helper.run(job, commands)

  expect(JSON.parse(await readFile(job.result, 'utf8'))).toMatchObject({ state: 'error', stage: 'prepare' })
})

it('客户本来就没连着：⛔ 留下接续标记，更新完不该自己连上', async () => {
  // 这条只断言「标记不该在」的话，交接那段整个被删掉它照样绿——没写标记和压根没走到，
  // 在「文件不存在」上长得一模一样。所以每一轮都要带一个「交接确实跑过」的正面证据：
  // bootout 发出去了、更新做完了。反向断言配正向证据才不怕假绿。
  for (const options of [{ intent: 'user-disconnected' }, {}]) {
    const { target, job, tunnelDataDir } = await macJob(options)
    const commands = commandsFor(job, [residentDaemonLine(job)])

    await helper.run(job, commands)

    expect(commands.mock.calls.some(([name]) => name === '/usr/bin/launchctl')).toBe(true)
    expect(await readFile(join(target, INSIDE), 'utf8')).toBe('new-version')
    expect(existsSync(join(tunnelDataDir, 'resume-on-launch'))).toBe(false)
  }
})

it('工具箱退出时已经把意图改成 shutdown 了，也要按退出前那一眼接着连', async () => {
  // 这是真实顺序：工具箱先走自己的退出流程（可能改写意图文件），助手才开始干活。
  // 只照着这时候的意图文件读，就会把「客户本来连着」误判成「客户自己断开的」= 更新完断网。
  const { job, tunnelDataDir } = await macJob({ intent: 'shutdown', tunnelResume: true })
  await helper.run(job, commandsFor(job, [residentDaemonLine(job)]))
  expect(existsSync(join(tunnelDataDir, 'resume-on-launch'))).toBe(true)
})

it('常驻停不掉也不许把更新卡死（最坏是旧守护活到下次重启）', async () => {
  const { target, job } = await macJob({ intent: 'connected' })
  const commands = vi.fn(async (command: string, args: string[]) => {
    if (command === '/usr/bin/launchctl') throw new Error('Boot-out failed: 3: No such process')
    if (command === '/usr/bin/ditto') await cp(args[0], args[1], { recursive: true })
    if (command === '/usr/bin/open') await writeFile(job.acknowledgement, JSON.stringify({ version: '0.5.0', pid: 1 }))
    return { stdout: command === '/bin/ps' ? `${residentDaemonLine(job)}\n` : '' }
  })

  await helper.run(job, commands)

  expect(JSON.parse(await readFile(job.result, 'utf8'))).toMatchObject({ state: 'complete' })
  expect(await readFile(join(target, INSIDE), 'utf8')).toBe('new-version')
})

it('交接要带的三样跟着更新任务一起发给助手，「本来连着」在工具箱还活着时就拍下来', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'toolbox-handoff-fields-'))
  cleanups.push(() => rm(userData, { recursive: true, force: true }))
  const tunnelDataDir = join(userData, 'tunnel')
  await mkdir(tunnelDataDir, { recursive: true })

  // 没有意图文件 = 没连着
  expect(residentHandoffFields(userData, {})).toEqual({ tunnelDataDir, residentLabel: RESIDENT_LABEL, tunnelResume: false })

  await writeFile(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'connected' }))
  expect(residentHandoffFields(userData, {})).toEqual({ tunnelDataDir, residentLabel: RESIDENT_LABEL, tunnelResume: true })

  await writeFile(join(tunnelDataDir, 'intent.json'), JSON.stringify({ desired: 'user-disconnected' }))
  expect(residentHandoffFields(userData, {})).toMatchObject({ tunnelResume: false })
})

it('Windows 卸载钩子：四步顺序不能反，升级 ⛔ 删登录任务', async () => {
  const script = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
  const at = (needle: string): number => {
    const index = script.indexOf(needle)
    expect(index, `installer.nsh 里找不到:${needle}`).toBeGreaterThan(-1)
    return index
  }
  // 「升级」判据 = 命令行上的 --updated（app-builder-lib 调旧卸载器时一定带）
  const guard = at('"--updated"')
  const deleteTask = at('schtasks.exe /delete')
  const branchEnd = script.indexOf('${EndIf}', deleteTask)
  const killDaemon = at('taskkill.exe /f /im "${APP_EXECUTABLE_FILENAME}"')
  const killKernel = at('taskkill.exe /f /im "xray.exe"')
  const restore = at('tunnel-daemon.mjs" restore')
  const fallback = at('"ProxyEnable" 0')

  // 1 删任务 → 2 停守护与内核 → 3 按账本还原 → 4 兜底关代理
  expect(guard).toBeLessThan(deleteTask)
  expect(deleteTask).toBeLessThan(killDaemon)
  expect(killDaemon).toBeLessThan(killKernel)
  expect(killKernel).toBeLessThan(restore)
  expect(restore).toBeLessThan(fallback)
  // 删任务在「真卸载」分支里；停守护、还原、兜底在分支外 —— 升级时这三样照做，任务不动
  expect(script.slice(0, deleteTask)).toContain('$5 == "uninstall"')
  expect(branchEnd).toBeGreaterThan(deleteTask)
  expect(branchEnd).toBeLessThan(killDaemon)
  // 任务名与主进程装的那一套一致:新路径(\Laixin\ 子文件夹,真机非提升可建)+ 旧版根路径残账清理
  expect(script).toContain('/tn "\\Laixin\\cn.laixin.toolbox.tunnel"')
  expect(script).toContain(`/tn "${RESIDENT_LABEL}"`)
})

// 兜底关代理的两条判据。原来那条两头都不对：只认 18 开头的口（候选全被占时系统随便挑一个高位口，
// 认不出 → 客户卸完永久断网、且工具箱已经没了没法修），而且不管还原成没成都开火。
it('兜底只在还原没成功时开火，且认整个回环而不是只认 18 开头的口', async () => {
  const script = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')

  // 正向证据：还原那一步确实把退出码留下来了（⛔ Pop 完就丢）
  expect(script).toMatch(/Pop \$0\s+StrCpy \$6 \$0/)
  // 兜底整段在「还原没成功」的判断里
  const guard = script.indexOf('${If} $6 != "0"')
  const readProxy = script.indexOf('"ProxyServer"')
  const writeEnable = script.indexOf('"ProxyEnable" 0')
  expect(guard).toBeGreaterThan(-1)
  expect(guard).toBeLessThan(readProxy)
  expect(readProxy).toBeLessThan(writeEnable)

  // 认口放宽到整个回环：取前 10 个字符比 `127.0.0.1:` / `localhost:`
  expect(script).toContain('StrCpy $2 $1 10')
  expect(script).toContain('${If} $2 == "127.0.0.1:"')
  expect(script).toContain('${OrIf} $2 == "localhost:"')
  // ⛔ 回到只认 18 开头
  expect(script).not.toContain('"127.0.0.1:18"')
  expect(script).not.toContain('StrCpy $2 $1 12')

  // 只关开关，⛔ 删客户的 ProxyServer 值（他的代理软件下次启动会自己写回去）
  expect(script).not.toMatch(/DeleteRegValue.*ProxyServer/)
})
