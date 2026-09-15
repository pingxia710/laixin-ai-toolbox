// 守护常驻（创始人 09-13 晚「所有围绕咱们稳定使用目标的都可以做」）：
// 让网络守护由**操作系统的用户级机制**看着——界面崩了、被杀了、开机还没打开工具箱，网络该在的时候就在。
//
// 三条硬边界，⛔ 越过：
//  1. **不要管理员权限**。用的是每用户机制（macOS LaunchAgent / Windows 登录计划任务），装的时候不弹授权框。
//     ⛔ 做成系统服务：系统服务替不了某个登录用户改他自己的代理设置（微软文档明写 WinINet 不给服务用），
//     而且会把「哪个用户的网络」这件事搅浑。
//  2. **正常退出不许被拉起**。客户点断开、退出账号、退出工具箱 → 守护还原后以 0 退出 → 系统 ⛔ 复活它。
//     只有非正常退出（崩溃、被杀、还原未完成的 65）才拉起。macOS 用 KeepAlive.SuccessfulExit=false 表达这条
//     （本机实测过：正常退出后起动次数不再增长，被杀后会被拉回来）。
//  3. **注册失败不许影响连接**。装不上常驻（系统限制、目录不可写）就回落到主进程自己带守护的老路，
//     最坏不比上一版差；⛔ 因为常驻装不上就不给客户连网。
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 每用户常驻的标签／任务名。改它等于换一个常驻实体，卸载旧的那套要跟着改。 */
export const RESIDENT_LABEL = 'cn.laixin.toolbox.tunnel'

export interface ResidentSpec {
  /** 可执行文件（打包后是工具箱主程序，以 ELECTRON_RUN_AS_NODE 当 node 用）。 */
  readonly executable: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** 守护日志落点（常驻进程没有父进程接管 stdio，⛔ 让它写进黑洞）。 */
  readonly logDir: string
}

export interface ResidentOutcome {
  readonly installed: boolean
  /** 装不上时的原因，只进日志与诊断，⛔ 弹给客户。 */
  readonly reason?: string
}

/** macOS LaunchAgent 描述文件。纯函数，便于用例逐字核对。 */
export function macAgentPlist(spec: ResidentSpec, label = RESIDENT_LABEL): string {
  const entry = (value: string): string => `<string>${escapeXml(value)}</string>`
  const args = [spec.executable, ...spec.args].map((value) => `      ${entry(value)}`).join('\n')
  const env = Object.entries(spec.env)
    .map(([key, value]) => `      <key>${escapeXml(key)}</key>${entry(value)}`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${entry(label)}
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardErrorPath</key>${entry(join(spec.logDir, 'tunnel-daemon.log'))}
</dict>
</plist>
`
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] ?? char)
}

export function macAgentPath(label = RESIDENT_LABEL): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

/** 已装的描述文件与要装的一字不差时跳过重装：⛔ 每次开工具箱都把守护踢下线重来。 */
function sameAsInstalled(path: string, content: string): boolean {
  try { return readFileSync(path, 'utf8') === content } catch { return false }
}

/** 装上 macOS 常驻。已装且内容一致就原样返回，⛔ 每次开工具箱都把守护踢下线重来。 */
export async function installMacResident(spec: ResidentSpec, label = RESIDENT_LABEL): Promise<ResidentOutcome> {
  const path = macAgentPath(label)
  const content = macAgentPlist(spec, label)
  try {
    mkdirSync(dirname(path), { recursive: true })
    mkdirSync(spec.logDir, { recursive: true })
    if (sameAsInstalled(path, content) && await macResidentLoaded(label)) return { installed: true }
    writeFileSync(path, content, { mode: 0o644 })
    // 先卸再装：描述文件换了内容而不重新加载，跑着的还是旧参数。
    await bootout(label)
    await run('launchctl', ['bootstrap', `gui/${String(process.getuid?.() ?? 0)}`, path])
    return { installed: true }
  } catch (error) {
    return { installed: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 卸掉 macOS 常驻（卸载工具箱、或客户关掉「后台保持连接」时）。⛔ 留下一个指向已删除程序的常驻项。 */
export async function uninstallMacResident(label = RESIDENT_LABEL): Promise<void> {
  await bootout(label)
  try { rmSync(macAgentPath(label), { force: true }) } catch { /* 删不掉下次再说，描述文件本身不会让守护跑起来 */ }
}

async function bootout(label: string): Promise<void> {
  try { await run('launchctl', ['bootout', `gui/${String(process.getuid?.() ?? 0)}/${label}`]) } catch { /* 没装过就没得卸 */ }
}

export async function macResidentLoaded(label = RESIDENT_LABEL): Promise<boolean> {
  try {
    await run('launchctl', ['print', `gui/${String(process.getuid?.() ?? 0)}/${label}`])
    return true
  } catch { return false }
}

// ---- Windows：登录计划任务（每用户、最低权限，⛔ 系统服务）----
// 2026-09-14 真机(pdf7, Win11 10.0.26200)复现台重写。真机事实驱动着这里的形状,⛔ 凭印象改回去:
//  · **含 LogonTrigger 的任务创建,非提升一律 Access denied**(schtasks /xml 与 Register-ScheduledTask
//    都拒,客户态 S-1-16-8192 实测)——这是这代 Windows 对登录触发器(恶意软件常用持久化原语)的硬化。
//    所以触发器只用 TimeTrigger+Repetition(每 1 分钟,无限):注册后 StartWhenAvailable 立即补跑、
//    重启后 ≤60 秒内拉起(断电件的语义保住,代价是最多 1 分钟的启动延迟)、崩溃后 60 秒内拉回。
//  · **schtasks /create /xml 非提升一律 Access denied**(与 Logon 无关);**Register-ScheduledTask -Xml
//    (COM API)非提升可用**——装任务走它。
//  · **任务 XML 带不了环境变量**:Exec 只有命令与参数,守护被 exe 当 GUI 路径拉起 = 4 进程僵尸、
//    不跑守护(真机复现)。动作改成 cmd /d /s /c 包装,先 set 再起守护(包装语法已过 Task Scheduler 实测)。
//  · **RestartOnFailure 在这台 Windows 上不重启**(exit 1 + PT1M×3 观察 4 分钟零重启),保活不押它:
//    每 1 分钟重入靠 MultipleInstancesPolicy=IgnoreNew 在守护活着时空转。
// 「正常退出不拉起」的语义由此表达:守护按 shutdown 意图干净收尾后**自禁任务**(见
// sidecar/win/tunnel-daemon.mjs 的 settleResidentTask),之后重入不再拉它——与 macOS
// KeepAlive.SuccessfulExit=false 同义;叫醒路径(schtasks /run)先 /change /enable 再跑,
// 所以「点连接必连上」不被自禁挡住。崩溃/被杀的守护没机会自禁,任务保持启用,60 秒内被拉回。

/** 计划任务路径。与 macOS 标签同尾名,方便两端一起查一起卸。 */
export const RESIDENT_TASK = `\\Laixin\\${RESIDENT_LABEL}`

/** 旧版(0.4.10 前)写在根文件夹的任务;新装/新卸时顺手清理,残留判据也要算它。 */
export const RESIDENT_TASK_LEGACY = RESIDENT_LABEL

/** 计划任务定义（schtasks /xml 用）。纯函数，便于用例逐字核对。 */
export function winTaskXml(spec: ResidentSpec, author = '来信AI工具箱'): string {
  const args = spec.args.map((value) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)).join(' ')
  const sets = Object.entries(spec.env).map(([key, value]) => `set "${key}=${value}"`).join('&& ')
  // 日志路径按 Windows 规矩统一反斜杠(node 的 join 在非 Windows 宿主上拼出混合分隔符,测试也要能逐字核对)
  const logPath = join(spec.logDir, 'tunnel-daemon.log').replace(/[/\\]+/g, '\\')
  const inner = `(${sets}&& "${spec.executable}" ${args} >> "${logPath}" 2>&1)`
  const command = escapeXml('C:\\Windows\\System32\\cmd.exe')
  const actionArguments = escapeXml(`/d /s /c "${inner}"`)
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${escapeXml(author)}</Author>
    <Description>来信AI工具箱网络守护：客户点过连接就保持在线，界面关掉或崩溃也不断网。</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
      <Arguments>${actionArguments}</Arguments>
      <WorkingDirectory>${escapeXml(spec.logDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

export async function installWinResident(spec: ResidentSpec, task = RESIDENT_TASK): Promise<ResidentOutcome> {
  const xmlPath = join(spec.logDir, 'resident-task.xml')
  try {
    mkdirSync(spec.logDir, { recursive: true })
    // 注册的 XML 读入由 [IO.File]::ReadAllText 完成(自动认 BOM);文件本身要 UTF-16LE 带 BOM,
    // ⛔ 写成 UTF-8(会报「任务 XML 包含意外节点」)。
    writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(winTaskXml(spec), 'utf16le')]))
    const taskName = task.split('\\').at(-1) ?? task
    const taskPath = task.slice(0, task.length - taskName.length) || '\\'
    // ⛔ schtasks /create /xml:这代 Windows 对非提升一刀切拒绝(真机实测);COM API(Register-ScheduledTask)
    // 不拒——装任务只走它。-Force = 已存在就覆盖(每次校准重装,守护参数跟着当前安装走)。
    const register = [
      `Register-ScheduledTask`,
      ` -TaskName '${winQuote(taskName)}'`,
      ` -TaskPath '${winQuote(taskPath)}'`,
      ` -Xml ([IO.File]::ReadAllText('${winQuote(xmlPath)}'))`,
      ' -Force'
    ].join('')
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', register], { timeout: 30_000 })
    // 装完回读确认:创建失败会在这里现形,⛔ 把「任务不在」当装上了报给界面。
    await run('schtasks.exe', ['/query', '/tn', task])
    // 旧版写在根文件夹的任务(只有恰好提升运行过的机器上才会有):清掉,⛔ 留着双份常驻。
    try { await run('schtasks.exe', ['/delete', '/tn', RESIDENT_TASK_LEGACY, '/f']) } catch { /* 没有残账就算了 */ }
    return { installed: true }
  } catch (error) {
    return { installed: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    try { rmSync(xmlPath, { force: true }) } catch { /* 临时文件删不掉不影响 */ }
  }
}

export async function uninstallWinResident(task = RESIDENT_TASK): Promise<void> {
  try { await run('schtasks.exe', ['/delete', '/tn', task, '/f']) } catch { /* 没建过就没得删 */ }
  try { await run('schtasks.exe', ['/delete', '/tn', RESIDENT_TASK_LEGACY, '/f']) } catch { /* 旧版残账同理 */ }
}

// ---- 叫醒已装的常驻 ----
// 客户上次点过断开 → 守护还原后以 0 退出 → 系统**不会**拉起它（这正是要的）。这时客户再点连接，
// 得有人立刻把它叫起来，⛔ 等到下次登录。mac 用 launchctl kickstart，win 用 schtasks /run。

export interface ResidentWake {
  readonly woken: boolean
  readonly reason?: string
}

export async function wakeMacResident(label = RESIDENT_LABEL): Promise<ResidentWake> {
  try {
    await run('launchctl', ['kickstart', `gui/${String(process.getuid?.() ?? 0)}/${label}`])
    return { woken: true }
  } catch (error) {
    return { woken: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function wakeWinResident(task = RESIDENT_TASK): Promise<ResidentWake> {
  try {
    // 守护干净收尾后会把任务自禁(sidecar/win/tunnel-daemon.mjs);叫醒是「有人真的需要它」,先解禁再跑。
    // ⛔ 只 /run:自禁态的任务 /run 会失败,客户的点连接会被当成「叫不醒」而放弃。
    try { await run('schtasks.exe', ['/change', '/tn', task, '/enable']) } catch { /* 任务不在:让 /run 去如实报错 */ }
    await run('schtasks.exe', ['/run', '/tn', task])
    return { woken: true }
  } catch (error) {
    return { woken: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// 「任务在」与「任务真的会拉起」在 Windows 上不是同一件事(2026-09-14 真机第 8 条的教训):
// 任务可以被禁用,也可以还挂着但永远不会跑出守护。给客户的 active 必须答后者——
// 用 Get-ScheduledTask 的 State 枚举(语言无关,⛔ 解析 schtasks /v 的本地化文本)判「在且未停用」。
// 这条探得起一个 powershell 进程,只允许走在拨开关/读设置的路径上,⛔ 放进状态轮询。
export async function winResidentArmed(task = RESIDENT_TASK): Promise<boolean> {
  const taskName = task.split('\\').at(-1) ?? task
  const taskPath = task.slice(0, task.length - taskName.length) || '\\'
  try {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-ScheduledTask -TaskPath '${winQuote(taskPath)}' -TaskName '${winQuote(taskName)}' -ErrorAction Stop).State`
    ], { timeout: 20_000 })
    const state = stdout.trim()
    return state === 'Ready' || state === 'Running' || state === 'Queued'
  } catch {
    return false
  }
}

/** 任务残留:新路径或旧版根文件夹任一处还在,都算没卸干净。 */
export async function winResidentResidue(task = RESIDENT_TASK): Promise<boolean> {
  for (const candidate of [task, RESIDENT_TASK_LEGACY]) {
    try { await run('schtasks.exe', ['/query', '/tn', candidate]); return true } catch { /* 这一处不在 */ }
  }
  return false
}

/** PowerShell 单引号串转义:翻倍即转义,⛔ 让任务名里的引号把命令拆了。 */
function winQuote(value: string): string {
  return value.replace(/'/g, "''")
}

/** 按平台叫醒；平台不认识时如实回报没叫醒，调用方回落到自己 spawn。 */
export async function wakeResident(platform: NodeJS.Platform | string = process.platform): Promise<ResidentWake> {
  if (platform === 'darwin') return await wakeMacResident()
  if (platform === 'win32') return await wakeWinResident()
  return { woken: false, reason: `平台 ${String(platform)} 不支持常驻` }
}

/** 按平台装；返回是否装上（装不上要如实降级，⛔ 因为常驻装不上就不给客户连网）。 */
export async function installResident(spec: ResidentSpec, platform: NodeJS.Platform | string = process.platform): Promise<ResidentOutcome> {
  if (platform === 'darwin') return await installMacResident(spec)
  if (platform === 'win32') return await installWinResident(spec)
  return { installed: false, reason: `平台 ${String(platform)} 不支持常驻` }
}

/** 按平台卸。⛔ 顺手动当前连接——卸常驻只是撤掉「以后自动拉起」。 */
export async function uninstallResident(platform: NodeJS.Platform | string = process.platform): Promise<void> {
  if (platform === 'darwin') { await uninstallMacResident(); return }
  if (platform === 'win32') await uninstallWinResident()
}
