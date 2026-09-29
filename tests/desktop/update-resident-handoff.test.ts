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

it('Windows 卸载钩子：先过任务/进程前置闸，再还原代理；升级 ⛔ 删登录任务', async () => {
  const script = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
  const macroStart = script.indexOf('!macro customUnInstall')
  const macroEnd = script.indexOf('!macroend', macroStart)
  expect(macroStart).toBeGreaterThan(-1)
  expect(macroEnd).toBeGreaterThan(macroStart)
  const body = script.slice(macroStart, macroEnd)
  const at = (needle: string): number => {
    const index = body.indexOf(needle)
    expect(index, `installer.nsh 里找不到:${needle}`).toBeGreaterThan(-1)
    return index
  }
  // 「升级」判据 = 命令行上的 --updated（app-builder-lib 调旧卸载器时一定带）
  const guard = at('"--updated"')
  const uninstallPreflight = at('!insertmacro runLaixinWindowsPreflight uninstall')
  const updatePreflight = at('!insertmacro runLaixinWindowsPreflight update')
  const restore = at('tunnel-daemon.mjs" restore')
  const fallback = at('-ProxyFallbackOnly')
  const aiCleanup = at('--laixin-ai-router-cleanup')

  // 1 区分更新/真卸载 → 2 前置闸收敛任务与精确路径进程 → 3 按账本还原 → 4 兜底关代理
  expect(guard).toBeLessThan(uninstallPreflight)
  expect(aiCleanup).toBeLessThan(uninstallPreflight)
  expect(guard).toBeLessThan(updatePreflight)
  expect(uninstallPreflight).toBeLessThan(restore)
  expect(updatePreflight).toBeLessThan(restore)
  expect(restore).toBeLessThan(fallback)
  // 真卸载走 delete+回读不存在；升级走 disable+回读 Disabled。入口不再直接吞 schtasks/taskkill 结果。
  expect(body.slice(0, uninstallPreflight)).toContain('$5 == "uninstall"')
  expect(script).toContain('windows-preflight ${MODE}')
  expect(script).not.toMatch(/taskkill(?:\.exe)?[^\r\n]*\/im\s+"?(?:xray\.exe|\$\{APP_EXECUTABLE_FILENAME\})/i)
})

// N-44:端口号不再证明归属；空账本或其他软件接管后必须留下现场。
it('卸载兜底只在还原未完成时开火，并按同会话账本与端口监听判定归属', async () => {
  const script = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
  const helper = await readFile(join(__dirname, '..', '..', 'resources', 'uninstall-task-cleanup.ps1'), 'utf8')

  // 正向证据：还原那一步确实把退出码留下来了（⛔ Pop 完就丢）
  expect(script).toMatch(/Pop \$0\s+\$\{If\} \$0 == "error"\s+StrCpy \$6 "not-run"\s+\$\{Else\}\s+StrCpy \$6 \$0\s+\$\{EndIf\}/)
  // 兜底整段在「还原没成功」的判断里
  const guard = script.indexOf('${If} $6 != "0"')
  const invokeFallback = script.indexOf('-ProxyFallbackOnly')
  expect(guard).toBeGreaterThan(-1)
  expect(guard).toBeLessThan(invokeFallback)
  expect(script.slice(invokeFallback)).toMatch(/Pop \$0[\s\S]*\$0 != "0"[\s\S]*StrCpy \$7 \$0/)

  expect(script.slice(invokeFallback)).toContain('-TunnelDataDir')
  expect(helper).toContain('LAIXIN_PROXY_LEDGER_OWNERSHIP')
  expect(helper).toContain('Get-NetTCPConnection -State Listen')
  expect(helper).toContain("Join-Path $TunnelDataDir 'ledger.json'")
  expect(helper).toContain('$server.writtenValue.data -ceq [string]$settings.ProxyServer')
  expect(helper).toContain('if (-not $owned) { exit 3 }')
  expect(helper).not.toContain('$loopback = $false')

  // 只关开关，⛔ 删客户的 ProxyServer 值（他的代理软件下次启动会自己写回去）
  expect(helper).not.toMatch(/Remove-ItemProperty[^\r\n]*ProxyServer/)
})

it('守护实际还原失败时，兜底成功也不能让普通卸载、静默卸载或升级删掉程序', async () => {
  const script = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
  const body = script.slice(script.indexOf('!macro customUnInstall'), script.indexOf('!macroend', script.indexOf('!macro customUnInstall')))
  const fallback = body.indexOf('-ProxyFallbackOnly')
  const commit = body.indexOf('!insertmacro commitLaixinWindowsPreflight')
  const abort = body.indexOf('SetErrorLevel 1\n    Abort')
  const deleteCache = body.indexOf('RMDir /r "$LOCALAPPDATA\\laixin-ai-toolbox-updater"')
  expect(fallback).toBeGreaterThan(-1)
  expect(commit).toBeGreaterThan(fallback)
  expect(abort).toBeGreaterThan(commit)
  expect(deleteCache).toBeGreaterThan(abort)

  // 从实际 NSIS 条件读出退出码闸，再用不同入口和返回码求值；兜底只恢复 WinINET。
  const gate = body.slice(fallback, commit).match(/\$\{If\} \$6 != "0"\s+\$\{AndIf\} \$6 != "not-run"\s+\$\{AndIf\} \$7 == "0"\s+StrCpy \$7 (\$6|"[^"]*")\s+\$\{EndIf\}/)
  expect(gate).not.toBeNull()
  const predicates = [...gate![0].matchAll(/\$\{(?:If|AndIf)\} (\$[67]) (==|!=) "([^"]+)"/g)]
  expect(predicates).toHaveLength(3)
  const blocksRemoval = (restore: string, fallbackExit: string, preflightExit = '0'): boolean => {
    const values: Record<string, string> = { $6: restore === 'error' ? 'not-run' : restore, $7: preflightExit }
    if (restore !== '0' && fallbackExit !== '0') values.$7 = fallbackExit
    if (predicates.every(([, variable, operator, expected]) => operator === '=='
      ? values[variable] === expected : values[variable] !== expected)) values.$7 = gate![1] === '$6' ? values.$6 : gate![1].slice(1, -1)
    return values.$7 !== '0'
  }

  for (const mode of ['uninstall', '/S', '--updated']) {
    expect(blocksRemoval('65', '0'), `${mode}: restore=65、fallback=0`).toBe(true)
    expect(blocksRemoval('error', '0'), `${mode}: 守护未能启动、fallback=0`).toBe(false)
    expect(blocksRemoval('0', '0'), `${mode}: restore=0`).toBe(false)
    expect(blocksRemoval('not-run', '0'), `${mode}: 残缺安装无 daemon`).toBe(false)
    expect(blocksRemoval('65', '7'), `${mode}: 两种恢复都失败`).toBe(true)
    expect(blocksRemoval('not-run', '3'), `${mode}: 空账本归属不明时不能删掉恢复入口`).toBe(true)
    expect(blocksRemoval('error', '3'), `${mode}: 程序损坏且归属不明时不能宣称网络已恢复`).toBe(true)
    expect(blocksRemoval('0', '0', '9'), `${mode}: 前置闸失败`).toBe(true)
  }
  expect(body).toMatch(/\$\{GetOptions\} \$3 "--updated" \$4\s+\$\{If\} \$\{Errors\}\s+StrCpy \$5 "uninstall"\s+\$\{Else\}\s+StrCpy \$5 "update"/)
  const commitGuard = body.lastIndexOf('${If} $5 == "uninstall"', commit)
  expect(body.slice(commitGuard, commit)).toContain('${AndIf} $7 == "0"')
  const failureGate = body.indexOf('${If} $7 != "0"', commit)
  expect(failureGate).toBeGreaterThan(commit)
  expect(failureGate).toBeLessThan(abort)
  expect(body.slice(failureGate, abort + 'SetErrorLevel 1\n    Abort'.length)).toMatch(/\$\{If\} \$5 == "uninstall"[\s\S]*\$\{GetOptions\} \$3 "\/S" \$4[\s\S]*\$\{If\} \$\{Errors\}[\s\S]*\$\{EndIf\}\s+\$\{EndIf\}\s+SetErrorLevel 1\s+Abort/)
})

it('主 EXE 缺失但 sidecar 留存时不尝试启动守护，残缺安装仍可走代理兜底', async () => {
  const script = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
  const body = script.slice(script.indexOf('!macro customUnInstall'), script.indexOf('!macroend', script.indexOf('!macro customUnInstall')))
  const restore = body.slice(body.indexOf('StrCpy $6 "not-run"'), body.indexOf('; 3) 兜底关代理'))
  expect(restore).toMatch(/\$\{If\} \$\{FileExists\} "\$INSTDIR\\resources\\sidecar\\win\\tunnel-daemon\.mjs"\s+\$\{AndIf\} \$\{FileExists\} "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/)
  expect(restore).toMatch(/\$\{If\} \$0 == "error"\s+StrCpy \$6 "not-run"/)
})

// 2026-09-15 客户实测「连着网点更新重启,又换回旧版」:0.5.5 客户端的更新助手调安装器前不停
// 守护/内核,旧卸载器的 taskkill 之后常驻任务还开着,每 1 分钟重入可能在「杀掉 → 新文件落盘」
// 覆盖只能由已安装工具箱的更新助手发起，customInit 重新验证交接；手工覆盖仍拒绝。
it('安装器 customInit:已安装目标只放行已验证 handoff，首次安装不误拦', async () => {
  const script = await readFile(join(__dirname, '..', '..', 'build', 'installer.nsh'), 'utf8')
  const initMacro = script.indexOf('!macro customInit')
  const uninstallMacro = script.indexOf('!macro customUnInstall')
  expect(initMacro).toBeGreaterThan(-1)
  expect(uninstallMacro).toBeGreaterThan(-1)

  const initEnd = script.indexOf('!macroend', initMacro)
  const initBody = script.slice(initMacro, initEnd)
  const existingInstall = initBody.indexOf('${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
  const handoff = initBody.indexOf('readLaixinWindowsPreflightHandoff')
  const abort = initBody.indexOf('Abort')
  expect(existingInstall).toBeGreaterThan(-1)
  expect(handoff).toBeGreaterThan(existingInstall)
  expect(abort).toBeGreaterThan(handoff)
  expect(initBody).not.toContain('runLaixinWindowsPreflight')
  expect(initBody).toMatch(/readLaixinWindowsPreflightHandoff \$R7[\s\S]*\$R7 != "1"[\s\S]*Abort/)
  expect(initBody).not.toContain('/delete')
  expect(initBody).not.toMatch(/taskkill(?:\.exe)?[^\r\n]*\/im/i)
})
