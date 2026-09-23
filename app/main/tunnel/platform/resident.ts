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
import { escapeCommandToken } from '../../shells/win-command'

const run = promisify(execFile)

/** 子进程超时分档(N-21)。定值照本文件 PowerShell 已有纪律:轻量查询/启停 20s,重装 30s。
 *  没这道闸,Task Scheduler 服务卡住(系统更新后常见)或 launchd 卡住时子进程永不退出,
 *  校准 Promise 永不落定,击穿校准闸门「任何校准结果都不能让接续永远等下去」——
 *  开机接续和等待期手动连接全部永远卡「正在接续」。 */
export const RESIDENT_CMD_TIMEOUT_MS = 20_000
export const RESIDENT_INSTALL_TIMEOUT_MS = 30_000

/** run + 超时闸(N-21):execFile 自带 timeout 负责杀掉卡死的子进程;外层同值兜一道,
 *  把「卡住」转成带原因的失败。reason 只进日志与诊断(ResidentOutcome.reason 既有口径),
 *  ⛔ 冒充 failure-codes 表里的已知码。 */
async function runBounded(file: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${file} ${String(args[0] ?? '')} ${String(timeoutMs / 1000)}s 未退出(超时):系统计划任务/launchd 服务可能卡住`)), timeoutMs)
  })
  try {
    return await Promise.race([run(file, args, { timeout: timeoutMs }), timedOut])
  } finally {
    clearTimeout(timer)
  }
}

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
  /** 系统里有一份当前用户无法安全接管的存量任务：注册覆盖被拒，或本版拒绝常驻后旧任务又无法停用。
   *  运行时先按它承载：armed 照答「在」，走叫醒，⛔ 自己再 spawn 一份（整分钟任务也会再拉一次，
   *  两份并存就是 TUNNEL_WRITE_RIGHT_HELD）；设置页据此如实显示没生效并给自救动作（甲-10 返工）。 */
  readonly existingTaskStale?: boolean
  /** 需要先叫醒并核实的具体存量任务；不给时沿用当前任务，兼容旧调用方。 */
  readonly staleTaskPaths?: readonly string[]
  /** 本版拒绝常驻后仍无法停掉的旧任务；它仍可能被系统调度，⛔ 叫醒失败后主进程再自起。 */
  readonly unmanagedStale?: boolean
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

/** 装上 macOS 常驻。已装且内容一致就原样返回，⛔ 每次开工具箱都把守护踢下线重来。
 *  leaveRunningInstance=true（席位上有活守护时）只把新描述文件写好、**⛔ bootout/bootstrap**——
 *  bootout 会给在跑实例发 SIGTERM，等于为换一份描述文件把客户正连着的网当场掐断；
 *  新定义下次登录自然加载。守护死着才换装（bootout 只动得了已加载的空任务）。
 *  bootstrap 失败时，这次新写的描述文件回滚删除（甲-10）：带着 RunAtLoad 的孤儿描述文件会让
 *  launchd 在下次登录自己加载它，工具箱记着「没装上」、系统却武装了；已在盘上的旧定义不动。 */
export async function installMacResident(
  spec: ResidentSpec,
  label = RESIDENT_LABEL,
  options: { leaveRunningInstance?: boolean } = {}
): Promise<ResidentOutcome> {
  const path = macAgentPath(label)
  const content = macAgentPlist(spec, label)
  // 这次调用会不会把描述文件换成新内容:bootstrap 失败时只有新写的才回滚(甲-10)。
  // 软卸载(net-2)留下的、与要装内容一致的定义不算——它是孤儿 plist 唯一的清除者,⛔ 替它清场。
  let wroteNewContent = false
  try {
    mkdirSync(dirname(path), { recursive: true })
    mkdirSync(spec.logDir, { recursive: true })
    const loaded = await macResidentLoaded(label)
    if (sameAsInstalled(path, content) && loaded) return { installed: true }
    wroteNewContent = !sameAsInstalled(path, content)
    writeFileSync(path, content, { mode: 0o644 })
    if (loaded && options.leaveRunningInstance === true) return { installed: true }
    // 先卸再装：描述文件换了内容而不重新加载，跑着的还是旧参数（仅限没有活实例可踢的场合）。
    await bootout(label)
    await runBounded('launchctl', ['bootstrap', `gui/${String(process.getuid?.() ?? 0)}`, path], RESIDENT_INSTALL_TIMEOUT_MS)
    return { installed: true }
  } catch (error) {
    // bootstrap 没成,刚写的新内容就得撤:孤儿描述文件带 RunAtLoad,下次登录 launchd 会自己加载,
    // 变成「工具箱记着没装上、系统却武装了」(甲-10)。已在盘上的旧定义不动——那不是这次写的。
    if (wroteNewContent) {
      try { rmSync(path, { force: true }) } catch { /* 删不掉时如实报失败,原因里带上 */ }
    }
    return { installed: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 卸掉 macOS 常驻。leaveRunningInstance=true（客户关「后台保持连接」且守护在跑）只删描述文件——
 *  解除的是「下次开机自动拉起」，在跑实例活到客户自己点断开/退出/重启：它正常退出（0）后
 *  KeepAlive.SuccessfulExit=false 不会拉起，被杀才拉。⛔ bootout——那是对在跑实例发 SIGTERM；
 *  「launchctl disable 挡住重拉」也不成立（2026-09-16 本机实证：disable+kill 后 3 秒内被重新拉起）。
 *  下轮补强（创始人 09-16 认可的取舍边界）：软卸载后已加载 job 仍在 launchd 内存里，守护**被杀**时
 *  KeepAlive 仍会拉它一次；bootout 当场断连更严重，故本轮取软卸载。下轮补「守护正常退出（0）后
 *  确认 job 已卸载」（此刻 bootout 的是空任务，没有连接可断）。 */
export async function uninstallMacResident(
  label = RESIDENT_LABEL,
  options: { leaveRunningInstance?: boolean } = {}
): Promise<void> {
  if (options.leaveRunningInstance !== true) await bootout(label)
  try { rmSync(macAgentPath(label), { force: true }) } catch { /* 删不掉下次再说，描述文件本身不会让守护跑起来 */ }
}

async function bootout(label: string): Promise<void> {
  try { await runBounded('launchctl', ['bootout', `gui/${String(process.getuid?.() ?? 0)}/${label}`], RESIDENT_CMD_TIMEOUT_MS) } catch { /* 没装过就没得卸 */ }
}

export async function macResidentLoaded(label = RESIDENT_LABEL): Promise<boolean> {
  try {
    await runBounded('launchctl', ['print', `gui/${String(process.getuid?.() ?? 0)}/${label}`], RESIDENT_CMD_TIMEOUT_MS)
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

/** 计划任务动作(execute/arguments/workingDirectory,未做 XML 转义的原始值)。
 *  注册与「读回现有任务逐字段比对」共用同一份推导(甲-10 返工);纯函数,便于用例逐字核对。
 *  环境变量与日志重定向都内嵌在 arguments 里——逐字段比对它,就等于比对了整份守护启动定义。 */
export interface WinTaskAction {
  readonly execute: string
  readonly arguments: string
  readonly workingDirectory: string
}


/**
 * 计划任务动作里的参数只会再经过 conhost → cmd /s 一条链；它与 Node spawn('.cmd')
 * 的 cross-spawn 解析模型不同。后者的 ^" 会让任务表面以 0 退出、内层守护却根本不启动。
 * 这里只接收不含 cmd 元字符的参数；空格仍须按这条链的普通引号规则成组。
 */
function quoteWinTaskArgument(value: string): string {
  if (value === '') return '""'
  if (!/[\s"]/.test(value)) return value
  let quoted = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  quoted = quoted.replace(/(?=(\\+?)?)\1$/, '$1$1')
  return `"${quoted}"`
}

function winTaskSpecUnsupportedReason(spec: ResidentSpec): string | undefined {
  // %VAR% 的展开先于本任务链的参数解析，^% 与 %% 都不能在真实 conhost → cmd /s 中保真。
  // 与其让任务返回 0、守护却没起来，不如拒绝常驻并回落到主进程直启；连接本身不受影响。
  const values = [spec.executable, ...spec.args, spec.logDir, ...Object.entries(spec.env).flat()]
  if (values.some((value) => value.includes('%'))) {
    return 'Windows 常驻暂不支持路径或启动参数含 %；已跳过常驻，仍可正常点连接'
  }
  // cmd /s 的外层引号会与内层参数引号互相剥离；真机证明 A&B、A^B、A!B 即使无空格也无法可靠
  // 保真。这里宁可不用常驻，也不装一份每分钟静默失败的任务；主进程直启不经过这层 cmd 包装。
  if (values.some((value) => /["&|<>()^!]/.test(value))) {
    return 'Windows 常驻暂不支持路径或启动参数含 CMD 特殊字符；已跳过常驻，仍可正常点连接'
  }
  return undefined
}

function isWinTaskMissing(reason: string): boolean {
  // schtasks 的提示随系统语言变化；只把明确的「不存在」当作可忽略，其余（尤其拒绝访问、超时）
  // 都必须回传，不能把仍会每分钟唤醒的旧任务说成已安全降级。
  return /cannot find|does not exist|not exist|找不到|不存在|没有与此条件匹配/i.test(reason)
}

interface WinTaskDisableFailure {
  readonly task: string
  readonly reason: string
}

/** 不支持的任务参数不能保真启动。切到主进程直启前，先停掉同名和历史根目录任务；不能停时如实留下诊断。 */
async function disableWinResidentTasksForUnsupportedSpec(task: string): Promise<WinTaskDisableFailure[]> {
  const failures: WinTaskDisableFailure[] = []
  for (const candidate of new Set([task, RESIDENT_TASK_LEGACY])) {
    try {
      await runBounded('schtasks.exe', ['/change', '/tn', candidate, '/disable'], RESIDENT_CMD_TIMEOUT_MS)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (!isWinTaskMissing(reason)) failures.push({ task: candidate, reason })
    }
  }
  return failures
}

export function winTaskAction(spec: ResidentSpec): WinTaskAction {
  const unsupportedReason = winTaskSpecUnsupportedReason(spec)
  if (unsupportedReason !== undefined) throw new Error(unsupportedReason)
  // 2026-09-18 客户故障:用户名带空格(MR WHITE)时，exe 位不能加裸引号；空格必须保留 ^ 转义，
  // 否则会被 cmd 从中间切开。参数与重定向目标则不能复用 cross-spawn 的 ^"：它在任务计划的
  // conhost→cmd /s 链路会静默吞掉启动。两套解析契约不同，⛔ 再把它们合并成一条通用转义。
  // 推导只此一份:注册(XML)与读回比对(sameWinTaskAction)两条路径同享,⛔ 只改一半。
  const launch = [escapeCommandToken(spec.executable), ...spec.args.map(quoteWinTaskArgument)].join(' ')
  const sets = Object.entries(spec.env).map(([key, value]) => `set "${key}=${value}"`).join('&& ')
  // 日志路径按 Windows 规矩统一反斜杠(node 的 join 在非 Windows 宿主上拼出混合分隔符,测试也要能逐字核对)
  const logPath = join(spec.logDir, 'tunnel-daemon.log').replace(/[/\\]+/g, '\\')
  const inner = `(${sets}&& ${launch} >> ${quoteWinTaskArgument(logPath)} 2>&1)`
  return {
    execute: 'C:\\Windows\\System32\\conhost.exe',
    arguments: `--headless C:\\Windows\\System32\\cmd.exe /d /v:off /s /c "${inner}"`,
    workingDirectory: spec.logDir
  }
}

/** 计划任务定义（schtasks /xml 用）。纯函数，便于用例逐字核对。 */
export function winTaskXml(spec: ResidentSpec, author = '来信AI工具箱'): string {
  // ⛔ 直接把 cmd.exe 当 Command:任务以 InteractiveToken 跑(见下方 Principal——非提升建不了
  // LogonTrigger,只能走交互令牌),交互身份启动控制台程序 **窗口会显示给客户**;而守护一直跑着,
  // cmd 就一直等着它,所以那不是闪一下、是一个常驻的黑窗口杵在客户桌面上(2026-09-16 创始人真机撞见)。
  // Settings 里的 <Hidden>true</Hidden> 管不着这个——它只让任务在「任务计划程序」列表里不显示。
  // conhost --headless 是 Windows 自带的无窗口控制台宿主(WSL 用的同一个机制),让 cmd 照常跑、
  // 环境变量与日志重定向都不变,只是不再给它开窗口。⛔ 改用 powershell -WindowStyle Hidden:
  // 每分钟起一次 PowerShell 开销大得多,而且仍会闪一下。
  // 2026-09-16 Windows 真机三组对照(以截图为准,⛔ 用 MainWindowHandle 判:任务跑在交互桌面会话,
  // 从 SSH 会话查窗口句柄一律是 0,那个判据连对照组都不会红,等于没验):
  //   旧定义(直接 cmd.exe)        → 桌面出现 cmd.exe 黑窗口,守护起来
  //   本定义(conhost --headless)  → 桌面干净无窗口,守护照常起来
  //   参数不被识别(模拟 1809 前)  → conhost 忽略未知参数,**守护照常起来**,LastTaskResult=0;
  //     即老系统最坏退回「有黑窗口」,⛔ 变成「任务装上但守护起不来」的静默没网。失败形状可接受,
  //     故 ⛔ 为此再加一道装后自检。
  const action = winTaskAction(spec)
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
      <Command>${escapeXml(action.execute)}</Command>
      <Arguments>${escapeXml(action.arguments)}</Arguments>
      <WorkingDirectory>${escapeXml(action.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

export async function installWinResident(spec: ResidentSpec, task = RESIDENT_TASK): Promise<ResidentOutcome> {
  const unsupportedReason = winTaskSpecUnsupportedReason(spec)
  if (unsupportedReason !== undefined) {
    // 旧任务若继续启用，会在下一分钟又拉起一份解析不了 % 的守护；先停它，失败也不能伪称收尾完成。
    const failures = await disableWinResidentTasksForUnsupportedSpec(task)
    const existingTaskStale = failures.length > 0
    winResidentTaskStale = existingTaskStale
    const staleTaskPaths = failures.map((failure) => failure.task)
    return {
      installed: false,
      reason: failures.length === 0
        ? unsupportedReason
        : `${unsupportedReason}；旧常驻任务未停用：${failures.map((failure) => `${failure.task}: ${failure.reason}`).join('；')}`,
      ...(existingTaskStale ? { existingTaskStale: true, staleTaskPaths, unmanagedStale: true } : {})
    }
  }
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
    await runBounded('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', register], RESIDENT_INSTALL_TIMEOUT_MS)
    // 装完回读确认:创建失败会在这里现形,⛔ 把「任务不在」当装上了报给界面。
    await runBounded('schtasks.exe', ['/query', '/tn', task], RESIDENT_CMD_TIMEOUT_MS)
    // 旧版写在根文件夹的任务(只有恰好提升运行过的机器上才会有):清掉,⛔ 留着双份常驻。
    try { await runBounded('schtasks.exe', ['/delete', '/tn', RESIDENT_TASK_LEGACY, '/f'], RESIDENT_CMD_TIMEOUT_MS) } catch { /* 没有残账就算了 */ }
    winResidentTaskStale = false
    return { installed: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (!isAccessDenied(reason)) return { installed: false, reason }
    // 注册被拒(2026-09-17 真机:管理员令牌注册过的任务,普通权限覆盖必拒 0x80070005)。
    // 普通权限读得到它的定义、跑得起它——读回来与本次要装的逐字段比(⛔ 模糊匹配):
    const existing = await readWinTaskAction(task)
    if (existing === null) {
      // 任务不在(文件夹被锁等罕见形态):没有可比的定义,也没有「存量承载」可言。
      winResidentTaskStale = false
      return { installed: false, reason }
    }
    if (sameWinTaskAction(existing, winTaskAction(spec))) {
      // 一致 → 系统里这份就是我们要装的常驻,按装上报;运行时走叫醒,设置页如实显示生效。
      winResidentTaskStale = false
      return { installed: true }
    }
    // 不一致(安装位置变了等)→ 存量任务:如实报没装上,交给 armed 取值与设置页的自救文案。
    winResidentTaskStale = true
    return { installed: false, reason, existingTaskStale: true, staleTaskPaths: [task] }
  } finally {
    try { rmSync(xmlPath, { force: true }) } catch { /* 临时文件删不掉不影响 */ }
  }
}

export async function uninstallWinResident(task = RESIDENT_TASK): Promise<void> {
  try { await runBounded('schtasks.exe', ['/delete', '/tn', task, '/f'], RESIDENT_CMD_TIMEOUT_MS) } catch { /* 没建过就没得删 */ }
  try { await runBounded('schtasks.exe', ['/delete', '/tn', RESIDENT_TASK_LEGACY, '/f'], RESIDENT_CMD_TIMEOUT_MS) } catch { /* 旧版残账同理 */ }
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
    await runBounded('launchctl', ['kickstart', `gui/${String(process.getuid?.() ?? 0)}/${label}`], RESIDENT_CMD_TIMEOUT_MS)
    return { woken: true }
  } catch (error) {
    return { woken: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function wakeWinResident(task = RESIDENT_TASK): Promise<ResidentWake> {
  try {
    // 守护干净收尾后会把任务自禁(sidecar/win/tunnel-daemon.mjs);叫醒是「有人真的需要它」,先解禁再跑。
    // ⛔ 只 /run:自禁态的任务 /run 会失败,客户的点连接会被当成「叫不醒」而放弃。
    try { await runBounded('schtasks.exe', ['/change', '/tn', task, '/enable'], RESIDENT_CMD_TIMEOUT_MS) } catch { /* 任务不在:让 /run 去如实报错 */ }
    await runBounded('schtasks.exe', ['/run', '/tn', task], RESIDENT_CMD_TIMEOUT_MS)
    return { woken: true }
  } catch (error) {
    return { woken: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// ---- 轻暂停(N-26):客户暂停后确保常驻不再开机拉起 ----
// 守护干净收尾本会自禁任务(sidecar/win/tunnel-daemon.mjs 的 settleResidentTask);这里是主进程侧的
// 幂等补手,自禁没写上的机器(注册被拒的存量任务、权限差异等)也守住「暂停后开机不会自动连接」。

/** Windows 禁用常驻任务:形状照 wakeWinResident 的 enable 反向。任务本就禁用时再 /disable 仍成功
 *  (幂等);任务不在/被拒时如实返回 false,由调用方决定是否记录,⛔ 弹窗打扰已暂停的客户。 */
export async function disableWinResident(task = RESIDENT_TASK): Promise<boolean> {
  try {
    await runBounded('schtasks.exe', ['/change', '/tn', task, '/disable'], RESIDENT_CMD_TIMEOUT_MS)
    return true
  } catch {
    return false
  }
}

/** 按平台确保常驻禁用。mac 无需动作:launchd 的 KeepAlive.SuccessfulExit=false 已表达「正常退出不拉起」,
 *  守护自禁覆盖;⛔ 再 bootout/disable——那会动在跑实例或挡不住 KeepAlive(2026-09-16 本机实证)。 */
export async function ensureResidentDisabled(platform: NodeJS.Platform | string = process.platform): Promise<boolean> {
  if (platform === 'win32') return await disableWinResident()
  return true
}

// 「任务在」与「任务真的会拉起」在 Windows 上不是同一件事(2026-09-14 真机第 8 条的教训):
// 任务可以被禁用,也可以还挂着但永远不会跑出守护。给客户的 active 必须答后者——
// 用 Get-ScheduledTask 的 State 枚举(语言无关,⛔ 解析 schtasks /v 的本地化文本)判「在且未停用」。
// 再两层(甲-10 返工):任务在、没禁用,但这台进程注册被拒过时看读回比对的结果——
//  · 存量任务与这版定义不一致:没生效。哪怕它被每分钟触发拉起在跑,那也不是这版常驻,
//    ⛔ 报武装(设置页据此给自救动作);
//  · 定义一致:系统里那份就是我们要装的,照常按状态判,Ready 即生效。
// 这条探得起一个 powershell 进程,只允许走在拨开关/读设置的路径上,⛔ 放进状态轮询。
export async function winResidentArmed(task = RESIDENT_TASK): Promise<boolean> {
  if (winResidentTaskStale) return false
  const taskName = task.split('\\').at(-1) ?? task
  const taskPath = task.slice(0, task.length - taskName.length) || '\\'
  try {
    const { stdout } = await runBounded('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-ScheduledTask -TaskPath '${winQuote(taskPath)}' -TaskName '${winQuote(taskName)}' -ErrorAction Stop).State`
    ], RESIDENT_CMD_TIMEOUT_MS)
    const state = stdout.trim()
    return state === 'Ready' || state === 'Running' || state === 'Queued'
  } catch {
    return false
  }
}

/** 任务残留:新路径或旧版根文件夹任一处还在,都算没卸干净。 */
export async function winResidentResidue(task = RESIDENT_TASK): Promise<boolean> {
  for (const candidate of [task, RESIDENT_TASK_LEGACY]) {
    try { await runBounded('schtasks.exe', ['/query', '/tn', candidate], RESIDENT_CMD_TIMEOUT_MS); return true } catch { /* 这一处不在 */ }
  }
  return false
}

/** PowerShell 单引号串转义:翻倍即转义,⛔ 让任务名里的引号把命令拆了。 */
function winQuote(value: string): string {
  return value.replace(/'/g, "''")
}

// 2026-09-17 验收订正(甲-10 返工):管理员令牌注册过的任务(SSH 里建、客户以管理员跑过一次工具箱),
// 普通权限覆盖注册(Register-ScheduledTask -Force)一律「拒绝访问 0x80070005」——0.5.0 起发布版都用
// 这个接口装任务,客户以管理员跑一次就会进入这个状态。COM 与 schtasks CLI 建的都一样(真机对照 j10-P)。
// 普通权限对它:读定义 ✅、查状态 ✅、schtasks /run ✅;停用/删除/覆盖 ❌(真机 D 表)。
// 因此注册被拒时分两路(本进程内存态,不落盘——每次启动校准都会重装,重新注册成功即清零):
//  · 读回现有任务,与本次要装的定义逐字段比(execute/arguments/workingDirectory 全等,⛔ 模糊匹配):
//    一致 → 它就是这份常驻,按装上报(installed:true),运行时叫醒它,设置页如实显示生效;
//  · 不一致(安装位置变了等)→ 如实报没装上 + existingTaskStale:运行时仍由它承载(⛔ 并存两份),
//    设置页给自救动作。
// 2026-09-19 补:本版因 CMD 特殊字符拒绝常驻时，若旧任务也停不掉，同样不能把 Ready 误报成当前安装可用。
let winResidentTaskStale = false

/** 最近一次校准留有当前用户无法安全接管的存量任务(设置页的自救文案看这里;mac 恒 false)。 */
export function winResidentStaleTask(): boolean {
  return winResidentTaskStale
}

/** 注册被系统拒绝的判据:跨语言就这几族——英文「Access is denied」、中文「拒绝访问」、HRESULT
 *  0x80070005。中文 Windows 的报错经 execFile 按 utf8 解码,中文必成乱码(验收 K3 的教训),
 *  唯一稳定可认的是 HRESULT——⛔ 只认英文文本。 */
function isAccessDenied(message: string): boolean {
  return /access is denied|access denied|拒绝访问|0x80070005/i.test(message)
}

/** 读回现有计划任务的动作定义(普通权限读得到;读不到/不在/动作数不是 1 → null)。
 *  ConvertTo-Json 把非 ASCII 转义成 \uXXXX:输出纯 ASCII,⛔ 依赖控制台代码页——中文 Windows 的
 *  GBK 输出被按 utf8 解码就是乱码,逐字段比对会永远失配。 */
async function readWinTaskAction(task: string): Promise<WinTaskAction | null> {
  const taskName = task.split('\\').at(-1) ?? task
  const taskPath = task.slice(0, task.length - taskName.length) || '\\'
  try {
    const { stdout } = await runBounded('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      // ⛔ 中文 Windows 控制台代码页是 GBK:不先设 OutputEncoding,PS 按 GBK 写管道、Node 按 utf8
      // 解码,路径里的中文必成乱码 → 逐字段比对永远失配(2026-09-17 真机诊断实证,与验收 K3 同源)。
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ` +
      `$t = Get-ScheduledTask -TaskPath '${winQuote(taskPath)}' -TaskName '${winQuote(taskName)}' -ErrorAction Stop; ` +
      `if ($t.Actions.Count -ne 1) { 'ACTIONS=' + $t.Actions.Count } ` +
      `else { $a = $t.Actions[0]; ConvertTo-Json -Compress @{ execute = $a.Execute; arguments = $a.Arguments; workingDirectory = [string]$a.WorkingDirectory } }`
    ], RESIDENT_CMD_TIMEOUT_MS)
    const text = stdout.trim()
    if (!text.startsWith('{')) return null
    const parsed = JSON.parse(text) as { readonly execute?: unknown; readonly arguments?: unknown; readonly workingDirectory?: unknown }
    return {
      execute: typeof parsed.execute === 'string' ? parsed.execute : '',
      arguments: typeof parsed.arguments === 'string' ? parsed.arguments : '',
      workingDirectory: typeof parsed.workingDirectory === 'string' ? parsed.workingDirectory : ''
    }
  } catch { return null }
}

/** 逐字段全等:不去空白、不比前缀、不做路径归一,⛔ 模糊匹配(甲-10 返工判据)。 */
function sameWinTaskAction(a: WinTaskAction, b: WinTaskAction): boolean {
  return a.execute === b.execute && a.arguments === b.arguments && a.workingDirectory === b.workingDirectory
}

/** 按平台叫醒；平台不认识时如实回报没叫醒，调用方回落到自己 spawn。 */
export async function wakeResident(
  platform: NodeJS.Platform | string = process.platform,
  staleTaskPaths: readonly string[] = []
): Promise<ResidentWake> {
  if (platform === 'darwin') return await wakeMacResident()
  if (platform === 'win32') {
    // 多份不可停的旧任务本来就不安全；本轮只能尝试第一份，⛔ 同时 /run 把两份旧守护主动拉起来。
    return await wakeWinResident(staleTaskPaths[0] ?? RESIDENT_TASK)
  }
  return { woken: false, reason: `平台 ${String(platform)} 不支持常驻` }
}

/** 按平台装；返回是否装上（装不上要如实降级，⛔ 因为常驻装不上就不给客户连网）。 */
export async function installResident(
  spec: ResidentSpec,
  platform: NodeJS.Platform | string = process.platform,
  options: { leaveRunningInstance?: boolean } = {}
): Promise<ResidentOutcome> {
  if (platform === 'darwin') return await installMacResident(spec, RESIDENT_LABEL, options)
  if (platform === 'win32') return await installWinResident(spec)
  return { installed: false, reason: `平台 ${String(platform)} 不支持常驻` }
}

/** 按平台卸。⛔ 顺手动当前连接——卸常驻只是撤掉「以后自动拉起」；
 *  leaveRunningInstance 由调用方按席位判活传入，mac 上为真时绝不动在跑实例。 */
export async function uninstallResident(
  platform: NodeJS.Platform | string = process.platform,
  options: { leaveRunningInstance?: boolean } = {}
): Promise<void> {
  if (platform === 'darwin') { await uninstallMacResident(RESIDENT_LABEL, options); return }
  if (platform === 'win32') await uninstallWinResident()
}
