import { app, dialog, shell } from 'electron'
import { join } from 'node:path'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { createDeepSeekAdapters, observedConfigurationExecution } from '../ai-access/adapters'
import { createProjectConfigurationTargetStore } from '../ai-access/configuration-target'
import { createConfigurationExecutionObserver } from '../ai-access/configuration-execution-observer'
import { createManagedTextFile } from '../ai-access/file'
import { createRestartGuidanceReader, restartMessage, type ShellRestartGuidance } from '../ai-access/restart-guidance'
import { environmentChecklist, type EnvironmentChecklistItem } from '../ai-access/environment-checklist'
import { createAiAccessStore } from '../ai-access/store'
import { AiAccessService, aiAccessProviders, aiAccessShells, type AiAccessProvider, type AiAccessShell } from '../ai-access/service'
import { CodexOfficialLoginController, startCodexChatGptLogin } from '../ai-access/codex-official-login'
import { AiGateway } from '../ai-access/gateway'
import { createDesktopRouteAttestor } from '../ai-access/desktop-route-attestation'
import { modelProviders } from '../../shared/model-providers'
import { apiRemedyActions, type ApiRemedyAction, type ApiRemedyResult } from '../../shared/api-service-types'
import { recordFault } from '../diagnostics/context'
import { createModelMatrixFiles, ModelMatrixStore } from '../ai-access/model-matrix-store'
import { readProviderBalance } from '../ai-access/balance'
import { findIncompatibility, peakState, resolveProviderRoute, type Recipes } from '../recipes/recipes'
import { recipeStore, shellInventory } from '../shells/context'
import { trustedCliExecutable, trustedCliInstalled, trustedCliVersion, type ShellInventoryEntry } from '../shells/inventory'
import { ClaudeOfficialLoginController, readClaudeAuthStatus, startClaudeLogin } from '../ai-access/claude-official-login'
import { downloadTunnelSnapshot } from '../download/tunnel-runtime'
import { createUsageReceiptFileStore, createUsageReceiptRecorder, gatewayUsageEventToReceipt, normalizeClientVersion,
  type UsageReceiptRecorder } from '../ai-access/usage-receipt'
import { release } from 'node:os'

const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 100_000 }) })
/** 配置被别的工具改掉、睡醒后端口变了，都要在客户下次用之前被发现。 */
export const RECOVERY_INTERVAL_MS = 600_000
const shellSchema = schema.object({ shell: schema.string({ maxLength: 20 }) })
const providerKeySchema = schema.object({ shell: schema.string({ maxLength: 20 }), provider: schema.string({ maxLength: 20 }), key: schema.string({ maxLength: 512 }) })
const providerShellSchema = schema.object({ provider: schema.string({ maxLength: 20 }), shell: schema.string({ maxLength: 20 }) })
const configurationTargetSchema = schema.object({ shell: schema.string({ maxLength: 20 }), scope: schema.string({ maxLength: 10 }) })
const providerConfigurationSchema = schema.object({ shell: schema.string({ maxLength: 20 }), provider: schema.string({ maxLength: 20 }), key: schema.string({ maxLength: 512 }), model: schema.string({ maxLength: 128 }) })
// provider 传的是**这次失败针对的**那家；桥上不给可选字段，界面拿不准就传空串走回退。
const remedySchema = schema.object({ shell: schema.string({ maxLength: 20 }), action: schema.string({ maxLength: 20 }), provider: schema.string({ maxLength: 20 }) })

type ModelApiAccessActions = Pick<AiAccessService, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial'>
type ProjectConfigurationDirectoryPicker = () => Promise<string | undefined>
type RestartGuidanceReader = { read(shell: AiAccessShell): Promise<ShellRestartGuidance> }

/** Test-only seams keep the production bridge bound to its fixed local readers. */
export interface AiAccessActionRuntime {
  readonly restartGuidance?: RestartGuidanceReader
  /** Mac 使用回执（API-04）：注入替代生产单例，测试里配 showSaveDialog 验证取消与落盘。 */
  readonly usageReceipt?: UsageReceiptRecorder
  readonly showSaveDialog?: () => Promise<{ readonly canceled: boolean; readonly filePath?: string }>
}

export function registerAiAccessActions(
  registry: BridgeRegistry,
  access?: ModelApiAccessActions,
  codexLogin?: Pick<CodexOfficialLoginController, 'start' | 'status' | 'cancel'>,
  claudeLogin?: Pick<ClaudeOfficialLoginController, 'start' | 'status' | 'cancel' | 'submitCode'>,
  projectDirectoryPicker?: ProjectConfigurationDirectoryPicker,
  runtime: AiAccessActionRuntime = {}
): void {
  const resolvedAccess = access ?? productionAiAccessService()
  const restartGuidance = runtime.restartGuidance ?? (access === undefined ? productionRestartGuidanceReader() : undefined)
  // Mac 使用回执的两个手动动作：生成预览、（预览后）保存为本地文件。⛔ 没有上传或任何自动发送动作。
  const usageReceipt = runtime.usageReceipt ?? (access === undefined ? productionUsageReceiptRecorder() : undefined)
  if (usageReceipt !== undefined) {
    registry.registerAction({ name: 'aiaccess.usageReceipt', paramsSchema: schema.undefined(), resultSchema,
      handler: () => respond(usageReceipt.generate()) })
    registry.registerAction({ name: 'aiaccess.usageReceiptSave', paramsSchema: schema.object({ snapshotId: schema.string({ maxLength: 64 }) }), resultSchema,
      handler: async params => {
        // 保存只认主进程在预览时留存的快照标识；没有有效预览就 ⛔ 弋出系统保存对话框。
        const snapshotId = (params as { readonly snapshotId: string }).snapshotId
        const status = usageReceipt.peekSnapshot(snapshotId)
        if (status !== 'ok') return respond({ ok: false, reason: status })
        const picked = await (runtime.showSaveDialog ?? productionShowSaveDialog)()
        // 客户取消就到此为止：不写任何文件，也 ⛔ 把取消说成失败。
        if (picked.canceled || !picked.filePath) return respond({ ok: false, reason: 'canceled' })
        return respond(await usageReceipt.save(picked.filePath, snapshotId))
      } })
  }
  registry.registerAction({ name: 'aiaccess.status', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedAccess.status()) })
  registry.registerAction({ name: 'aiaccess.environmentChecklist', paramsSchema: schema.undefined(), resultSchema,
    handler: () => respond(publicEnvironmentChecklist(environmentChecklist)) })
  if (restartGuidance !== undefined) {
    registry.registerAction({ name: 'aiaccess.restartGuidance', paramsSchema: shellSchema, resultSchema, handler: async params => {
      const shell = readShell((params as { shell: string }).shell)
      return respond(publicRestartGuidance(shell, await restartGuidance.read(shell)))
    } })
  }
  registry.registerAction({ name: 'aiaccess.openProviderConsole', paramsSchema: schema.object({ provider: schema.string({ maxLength: 20 }) }), resultSchema,
    handler: async params => { await shell.openExternal(modelProviders[readProvider((params as { provider: string }).provider)].keyUrl); return { snapshot: '{}' } } })
  registry.registerAction({
    name: 'aiaccess.saveProviderKey', paramsSchema: providerKeySchema, resultSchema,
    handler: (params) => {
      const input = params as { readonly shell: string; readonly provider: string; readonly key: string }
      return respond(resolvedAccess.saveProviderKey(readShell(input.shell), readProvider(input.provider), input.key))
    }
  })
  registry.registerAction({
    name: 'aiaccess.useProvider', paramsSchema: providerShellSchema, resultSchema,
    handler: (params) => {
      const input = params as { readonly provider: string; readonly shell: string }
      return respond(resolvedAccess.useProvider(readShell(input.shell), readProvider(input.provider)))
    }
  })
  registry.registerAction({
    name: 'aiaccess.useOfficial', paramsSchema: shellSchema, resultSchema,
    handler: (params) => respond(resolvedAccess.useOfficial(readShell((params as { readonly shell: string }).shell)))
  })
  const resolvedLogin = codexLogin ?? (access === undefined ? productionCodexLogin(resolvedAccess) : undefined)
  if (resolvedLogin !== undefined) {
    registry.registerAction({ name: 'aiaccess.codexOfficialStatus', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedLogin.status()) })
    registry.registerAction({ name: 'aiaccess.startCodexOfficialLogin', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedLogin.start()) })
    registry.registerAction({ name: 'aiaccess.cancelCodexOfficialLogin', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedLogin.cancel()) })
  }
  const resolvedClaudeLogin = claudeLogin ?? (access === undefined ? productionClaudeLogin(resolvedAccess) : undefined)
  if (resolvedClaudeLogin !== undefined) {
    registry.registerAction({ name: 'aiaccess.claudeOfficialStatus', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedClaudeLogin.status()) })
    registry.registerAction({ name: 'aiaccess.startClaudeOfficialLogin', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedClaudeLogin.start()) })
    registry.registerAction({ name: 'aiaccess.submitClaudeLoginCode', paramsSchema: schema.object({ code: schema.string({ maxLength: 512 }) }), resultSchema, handler: (params) => respond(resolvedClaudeLogin.submitCode((params as { code: string }).code)) })
    registry.registerAction({ name: 'aiaccess.cancelClaudeOfficialLogin', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedClaudeLogin.cancel()) })
  }
  if (resolvedAccess instanceof AiAccessService) {
    registry.registerAction({ name: 'aiaccess.selectConfigurationTarget', paramsSchema: configurationTargetSchema, resultSchema, handler: params => {
      const input = params as { shell: string; scope: string }
      if (input.scope !== 'user' && input.scope !== 'project') throw new Error('AI_ACCESS_CONFIGURATION_TARGET_SCOPE_INVALID')
      return respond(resolvedAccess.selectConfigurationTarget(readShell(input.shell), input.scope))
    } })
    registry.registerAction({ name: 'aiaccess.selectConfigurationProject', paramsSchema: shellSchema, resultSchema, handler: async params => {
      const shell = readShell((params as { shell: string }).shell)
      // Native Codex never reads a project provider config. Reject before opening a file picker so
      // a stale renderer or direct bridge call cannot suggest a repair that the client ignores.
      if (shell !== 'claude') throw new Error('AI_ACCESS_CONFIGURATION_TARGET_UNSUPPORTED')
      const projectDir = await (projectDirectoryPicker ?? pickProjectConfigurationDirectory)()
      return respond(projectDir === undefined
        ? resolvedAccess.status()
        : resolvedAccess.selectConfigurationProject(shell, projectDir))
    } })
    registry.registerAction({ name: 'aiaccess.restorePreviousConnection', paramsSchema: shellSchema, resultSchema,
      handler: params => respond(resolvedAccess.restorePreviousConnection(readShell((params as { shell: string }).shell))) })
    registry.registerAction({ name: 'aiaccess.configureProvider', paramsSchema: providerConfigurationSchema, resultSchema, handler: params => {
      const input = params as { shell: string; provider: string; key: string; model: string }
      return respond(resolvedAccess.configureProvider(readShell(input.shell), readProvider(input.provider), input.key, input.model))
    } })
    registry.registerAction({ name: 'aiaccess.measureProviderLatency', paramsSchema: providerConfigurationSchema, resultSchema, handler: params => {
      const input = params as { shell: string; provider: string; key: string; model: string }
      return respond(resolvedAccess.measureProviderLatency(readShell(input.shell), readProvider(input.provider), input.key, input.model))
    } })
    registry.registerAction({ name: 'aiaccess.providerConfiguration', paramsSchema: providerShellSchema, resultSchema, handler: params => {
      const input = params as { provider: string; shell: string }
      return respond(resolvedAccess.providerConfiguration(readShell(input.shell), readProvider(input.provider)))
    } })
    registry.registerAction({ name: 'aiaccess.serviceStatus', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedAccess.serviceStatus()) })
    registry.registerAction({ name: 'aiaccess.remedy', paramsSchema: remedySchema, resultSchema, handler: async params => {
      const input = params as { shell: string; action: string; provider: string }
      const software = readShell(input.shell), action = readRemedyAction(input.action)
      const intended = input.provider === '' ? undefined : readProvider(input.provider)
      if (action !== 'openConsole') return respond(resolvedAccess.remedy(software, action, intended))
      // 打开控制台没有可复验的结果：老实说「不能确认」，⛔ 当成已修好。
      const selected = intended ?? (await resolvedAccess.status()).shells[software].selected
      const provider = aiAccessProviders.includes(selected as AiAccessProvider) ? selected as AiAccessProvider : null
      if (provider) await shell.openExternal(modelProviders[provider].keyUrl)
      // 打开控制台也是客户「试过的处理」，客服要看得到。
      recordFault({ shell: software, ...(provider ? { provider } : {}), action, outcome: 'unknown' })
      const result: ApiRemedyResult = { shell: software, provider, action, at: new Date().toISOString(), outcome: 'unknown',
        message: provider ? `已打开 ${modelProviders[provider].title} 的控制台。请在那里确认 Key、余额与权限，再回来重新测试。`
          : '这个 AI 现在用的是官方配置，没有对应的服务商控制台。',
        ...(provider ? { next: 'retest' as const } : {}) }
      return respond(result)
    } })
    registry.registerAction({ name: 'aiaccess.testProvider', paramsSchema: providerShellSchema, resultSchema, handler: params => {
      const input = params as { provider: string; shell: string }
      return respond(resolvedAccess.testProvider(readShell(input.shell), readProvider(input.provider)))
    } })
    registry.registerAction({ name: 'aiaccess.providerBalance', paramsSchema: providerShellSchema, resultSchema, handler: async params => {
      const input = params as { provider: string; shell: string }
      const provider = readProvider(input.provider), shell = readShell(input.shell)
      const balance = await readProviderBalance(provider, await resolvedAccess.providerKey(shell, provider))
      return respond({ ...balance, peak: peakState(recipeStore().current(), provider) })
    } })
    registry.registerAction({ name: 'aiaccess.verifyConfiguration', paramsSchema: schema.undefined(), resultSchema,
      handler: () => respond(resolvedAccess.verifyConfigurations()) })
    // 矩阵一次要跑几十格、分钟级，桥上没有推送通道：这里只起跑，进度由 matrixStatus 轮询。
    let matrix: Promise<unknown> | undefined
    registry.registerAction({ name: 'aiaccess.probeMatrix', paramsSchema: schema.undefined(), resultSchema, handler: () => {
      matrix ??= resolvedAccess.probeMatrix().finally(() => { matrix = undefined })
      return respond(matrix)
    } })
    registry.registerAction({ name: 'aiaccess.matrixStatus', paramsSchema: schema.undefined(), resultSchema,
      handler: () => respond({ ...resolvedAccess.matrixStatus(), running: matrix !== undefined }) })
    registry.registerAction({ name: 'aiaccess.recover', paramsSchema: schema.undefined(), resultSchema,
      handler: () => respond(resolvedAccess.recoverAccess('manual')) })
    registry.registerShutdownHook('aiaccess.gateway', () => resolvedAccess.stop())
    // No requests to providers and no shell writes occur during restoration.
    const restored = resolvedAccess.initialize()
    void restored
    // 生产合成才起后台核对：重开后先对一次，之后每 10 分钟一次，顺带覆盖唤醒与断网恢复。
    if (access === undefined) {
      void restored.then(() => resolvedAccess.recoverAccess('startup')).catch(() => undefined)
      const timer = setInterval(() => { void resolvedAccess.recoverAccess('periodic').catch(() => undefined) }, RECOVERY_INTERVAL_MS)
      timer.unref?.()
      registry.registerShutdownHook('aiaccess.recovery', () => { clearInterval(timer); return Promise.resolve() })
    }
  }
}

/** 版本兼容闸门:装上了但版本没读出来,**且配方里给这个壳列过不兼容版本**时,按不通过处理——宁可拦。
 * 空版本一律放行等于黑名单形同虚设:Windows 上版本检测本来就长期恒空(0.4.10 包一第 2 条),
 * 客户就这样被放去用一个已知会报 400 的版本。检测修好只是堵住一个来源,闸门自己也得守住。
 * 反过来,配方里压根没给这个壳(和这家 provider)列过任何条目,「版本不知道」也撞不上东西,
 * 这时拦下来纯属挡路——mac 上 Hermes 读不到 Info.plist 版本就属于这种。 */
export function versionGateMessage(recipes: Recipes, shell: AiAccessShell, provider: AiAccessProvider | undefined,
  entry: Pick<ShellInventoryEntry, 'installed' | 'version' | 'label'>): string | undefined {
  if (entry.installed !== true) return undefined
  if (!entry.version) {
    // 「这个壳有没有东西可撞」按 findIncompatibility 的同一套 shell + provider 规则判,只是不看版本号。
    const exposed = recipes.incompatibilities.some((item) => item.shell === shell &&
      (provider === undefined || item.providers === undefined || item.providers.includes(provider)))
    return exposed ? `暂时读不出 ${entry.label} 的版本号，无法确认它与第三方模型接口是否兼容。为免装上不兼容的版本后一直报错，先不启用；请重新打开工具箱再试一次，仍然不行请联系来信客服协助。` : undefined
  }
  return findIncompatibility(recipes, shell, entry.version, provider)?.message
}

/**
 * The AI-access gate must never use the general inventory: its PATH probing can execute a
 * customer wrapper. A missing trusted command is a blocking, explainable state rather than an
 * invitation to try the PATH hit. A trusted native command may still provide its version for
 * the normal recipe incompatibility gate.
 */
export async function trustedVersionGateMessage(recipes: Recipes, shell: AiAccessShell, provider: AiAccessProvider | undefined,
  platform: string, home: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const id: 'codex' | 'claude-code' | 'hermes' = shell === 'claude' ? 'claude-code' : shell
  const trusted = await trustedCliVersion(id, platform, home, env)
  const label = recipes.shells[id].label
  if (trusted === undefined) {
    return `未能在官方安装位置确认 ${label}。为避免执行未知 PATH 包装器，当前不能启用第三方模型 API；请从工具箱完成官方安装后重试。`
  }
  if (trusted.versionUnknown) {
    return `暂时无法确认 ${label} 的版本。为避免在未验证版本上持续报错，当前不能启用第三方模型 API；请重新安装或更新官方客户端后重试。`
  }
  return versionGateMessage(recipes, shell, provider, { installed: true, version: trusted.version, label })
}

let productionRestartGuidance: RestartGuidanceReader | undefined
export function productionRestartGuidanceReader(): RestartGuidanceReader {
  productionRestartGuidance ??= createRestartGuidanceReader()
  return productionRestartGuidance
}

let productionMatrix: ModelMatrixStore | undefined
export function productionModelMatrixStore(): ModelMatrixStore {
  productionMatrix ??= new ModelMatrixStore(createModelMatrixFiles(join(app.getPath('userData'), 'model-matrix.json')))
  return productionMatrix
}

let productionUsageReceipt: UsageReceiptRecorder | undefined
/** Mac 使用回执单例：仅 macOS 记录，白名单字段落 userData/ai-access/usage-receipt.json。 */
export function productionUsageReceiptRecorder(): UsageReceiptRecorder {
  productionUsageReceipt ??= createUsageReceiptRecorder({
    platform: process.platform,
    version: app.getVersion(),
    osVersion: macOsVersion(),
    store: createUsageReceiptFileStore(join(app.getPath('userData'), 'ai-access')),
    clientVersion: productionClientVersionReader()
  })
  return productionUsageReceipt
}

/**
 * 客户端版本只从受信任安装位置读（⛔ PATH 包装器），按壳缓存一次；
 * 读取器自带 2.5 秒兜底：读不到、超时、报错一律归一为 unknown，⛔ 拖慢或打断记录。
 */
export function productionClientVersionReader(): (shell: AiAccessShell) => Promise<string> {
  const cache = new Map<AiAccessShell, Promise<string>>()
  return shell => {
    let reading = cache.get(shell)
    if (reading === undefined) {
      reading = withinTimeout(
        trustedCliVersion(shell === 'claude' ? 'claude-code' : shell, process.platform, app.getPath('home'), shellInventory().environment()),
        2_500
      ).then(version => normalizeClientVersion(version?.version)).catch(() => 'unknown')
      cache.set(shell, reading)
    }
    return reading
  }
}

function withinTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('USAGE_RECEIPT_VERSION_TIMEOUT')) }, timeoutMs)
    timer.unref?.()
    operation.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

/** 客户要的是 macOS 版本号；读不出真实版本就如实写 unknown，⛔ 编一个数。 */
function macOsVersion(): string {
  const reported = process.getSystemVersion?.() ?? ''
  if (/^\d+(\.\d+)*$/.test(reported)) return reported
  const kernel = release()
  return /^\d+(\.\d+)*$/.test(kernel) ? kernel : 'unknown'
}

/** 保存对话框留在主进程；路径既不进状态也不回渲染层。 */
async function productionShowSaveDialog(): Promise<{ readonly canceled: boolean; readonly filePath?: string }> {
  const picked = await dialog.showSaveDialog({ title: '保存 Mac 使用回执', defaultPath: '来信AI工具箱-Mac使用回执.txt',
    filters: [{ name: '文本', extensions: ['txt'] }] })
  return picked.canceled || !picked.filePath ? { canceled: true } : { canceled: false, filePath: picked.filePath }
}

let productionAccess: AiAccessService | undefined
export function productionAiAccessService(): AiAccessService {
  if (productionAccess) return productionAccess
  const home = app.getPath('home')
  const environment = shellInventory().environment()
  const file = createManagedTextFile()
  const observeConfigurationExecution = createConfigurationExecutionObserver({ platform: process.platform, home })
  // Mac 使用回执（API-04）：主进程侧五个固定阶段的白名单记录；⛔ 因记录失败影响主流程。
  const usageReceipt = productionUsageReceiptRecorder()
  productionAccess = new AiAccessService(
    createAiAccessStore(join(app.getPath('userData'), 'ai-access')),
    createDeepSeekAdapters({
      home,
      platform: process.platform,
      localAppData: environment.LOCALAPPDATA,
      hermesHome: environment.HERMES_HOME,
      // No process.cwd(): it is the Toolbox process, not evidence of a customer's project.
      configurationExecution: observedConfigurationExecution(home, process.platform, environment),
      observeConfigurationExecution,
      // The selected project root is retained only in this 0600 main-process file. Status and
      // renderer messages receive target scope/reason evidence, never the customer path.
      projectTargetStore: createProjectConfigurationTargetStore(file, join(app.getPath('userData'), 'ai-access', 'private-project-targets.json'), process.platform),
      file
    }),
    // The generic request ledger accepts all native clients; this stricter macOS observer is
    // attached only in production to tell Codex Desktop apart from the CLI without reading data.
    new AiGateway({
      desktopAttestor: createDesktopRouteAttestor(),
      onUsageEvent: event => usageReceipt.record(gatewayUsageEventToReceipt(event))
    }),
    {
      // Do not block a customer on a CLI version. Stable provider differences are normalized by
      // the gateway capability table; actual trusted-install validation stays in shellInstalled.
      resolveRoute: (shell, provider) => resolveProviderRoute(recipeStore().current(), shell, provider,
        { endpoint: modelProviders[provider].endpoints[shell], model: modelProviders[provider].models[shell] }),
      recordFault,
      recordUsageEvent: event => usageReceipt.record(event),
      // 真 Key 矩阵只做受信任安装位置的存在性检查。不能为此调用通用盘点，
      // 因为它会执行 PATH 中未知包装器的 --version。
      shellInstalled: async (software) => trustedCliInstalled(software === 'claude' ? 'claude-code' : software,
        process.platform, home, environment),
      saveMatrix: (report) => productionModelMatrixStore().save(report)
    }
  )
  return productionAccess
}

/** The native dialog keeps the raw directory inside the main process; the renderer receives only status evidence. */
async function pickProjectConfigurationDirectory(): Promise<string | undefined> {
  const selected = await dialog.showOpenDialog({ title: '选择项目配置目录', properties: ['openDirectory'] })
  return selected.canceled || selected.filePaths.length !== 1 ? undefined : selected.filePaths[0]
}

function productionCodexLogin(access: ModelApiAccessActions): CodexOfficialLoginController {
  if (!(access instanceof AiAccessService)) throw new Error('AI_ACCESS_SERVICE_INVALID')
  const home = app.getPath('home')
  const environment = async (): Promise<NodeJS.ProcessEnv> => ({
    ...shellInventory().environment(),
    // Finder-launched Toolbox may not inherit a terminal's CODEX_HOME. The adapter resolves the
    // same verified root used for config.toml and auth.json; it never leaves this login command.
    CODEX_HOME: await access.codexOfficialLoginRoot()
  })
  return new CodexOfficialLoginController({
    findCommand: async () => {
      const commandEnvironment = await environment()
      const executable = await trustedCliExecutable('codex', process.platform, home, commandEnvironment)
      return executable === undefined ? null : { executable, args: ['app-server', '--listen', 'stdio://'], environment: commandEnvironment }
    },
    startLogin: (command) => startCodexChatGptLogin(command, { cwd: home, openExternal: (url) => shell.openExternal(url) }),
    useOfficial: (software) => access.useOfficial(software)
  })
}

function productionClaudeLogin(access: ModelApiAccessActions): ClaudeOfficialLoginController {
  if (!(access instanceof AiAccessService)) throw new Error('AI_ACCESS_SERVICE_INVALID')
  const home = app.getPath('home')
  const environment = (): NodeJS.ProcessEnv => {
    const env = shellInventory().environment()
    const tunnel = downloadTunnelSnapshot()
    const proxy = tunnel.state === 'connected' && tunnel.localProxyUrl ? tunnel.localProxyUrl : undefined
    return proxy ? { ...env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy } : env
  }
  const findCommand = async () => {
    const executable = await trustedCliExecutable('claude-code', process.platform, home, environment())
    return executable === undefined ? null : { executable, args: ['auth', 'login'] }
  }
  return new ClaudeOfficialLoginController({
    findCommand,
    startLogin: (command) => startClaudeLogin(command, { cwd: home, env: environment(), openExternal: (url) => shell.openExternal(url),
      statusCheck: () => readClaudeAuthStatus({ executable: command.executable, args: [] }, environment()) }),
    useOfficial: (software) => access.useOfficial(software)
  })
}

function readShell(value: string): AiAccessShell {
  if (!aiAccessShells.includes(value as AiAccessShell)) throw new Error('AI_ACCESS_SHELL_INVALID')
  return value as AiAccessShell
}

function readRemedyAction(value: string): ApiRemedyAction {
  if (!apiRemedyActions.includes(value as ApiRemedyAction)) throw new Error('AI_ACCESS_REMEDY_INVALID')
  return value as ApiRemedyAction
}

function readProvider(value: string): AiAccessProvider {
  if (!aiAccessProviders.includes(value as AiAccessProvider)) throw new Error('AI_ACCESS_PROVIDER_INVALID')
  return value as AiAccessProvider
}

const shellProcessStates = ['running', 'not-running', 'unknown'] as const

interface PublicEnvironmentChecklistItem {
  readonly id: number
  readonly title: string
  readonly detection: Readonly<{ mode: string; strategy: string }>
  readonly handling: Readonly<{ mode: string; strategy: string }>
  readonly safetyBoundaryReason: string
}

/** The checklist is public guidance, but project paths/capability internals stay out of IPC. */
function publicEnvironmentChecklist(items: readonly EnvironmentChecklistItem[]): readonly PublicEnvironmentChecklistItem[] {
  if (items.length !== 27) throw new Error('AI_ACCESS_ENVIRONMENT_CHECKLIST_INVALID')
  return items.map(item => ({
    id: item.id,
    title: item.title,
    detection: { mode: item.detection.mode, strategy: item.detection.strategy },
    handling: { mode: item.handling.mode, strategy: item.handling.strategy },
    safetyBoundaryReason: item.safetyBoundaryReason
  }))
}

function publicRestartGuidance(shell: AiAccessShell, value: unknown): ShellRestartGuidance {
  if (!record(value) || !isOneOf(value.process, shellProcessStates)) throw new Error('AI_ACCESS_RESTART_GUIDANCE_RESULT_INVALID')
  // Do not trust arbitrary reader text at the boundary. The customer only needs the fixed
  // shell-specific action, and this prevents process details from crossing IPC by accident.
  return { shell, process: value.process, message: restartMessage(shell, value.process) }
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function respond(operation: Promise<unknown> | unknown): Promise<{ readonly snapshot: string }> {
  return { snapshot: JSON.stringify(await operation) }
}

export function registerActions(registry: BridgeRegistry): void {
  registerAiAccessActions(registry)
}
