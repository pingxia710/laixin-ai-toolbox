import { app, dialog, shell, session } from 'electron'
import { join } from 'node:path'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { createDeepSeekAdapters, observedConfigurationExecution } from '../ai-access/adapters'
import { createProjectConfigurationTargetStore } from '../ai-access/configuration-target'
import { createConfigurationExecutionObserver, configurationObservationTtlMs } from '../ai-access/configuration-execution-observer'
import { createManagedTextFile } from '../ai-access/file'
import { createRestartGuidanceReader, restartMessage, type ShellRestartGuidance } from '../ai-access/restart-guidance'
import { environmentChecklist, type EnvironmentChecklistItem } from '../ai-access/environment-checklist'
import { createAiAccessStore } from '../ai-access/store'
import { AiRouterController } from '../ai-access/router-controller'
import { deactivateCodexWorkspaceProviders, readCodexWorkspaceCatalogStatus } from '../ai-access/codex-workspace-config'
import { AiAccessService, aiAccessProviders, aiAccessShells, type AiAccessProvider, type AiAccessShell, type AiAccessStatus } from '../ai-access/service'
import { CodexOfficialLoginController, startCodexChatGptLogin } from '../ai-access/codex-official-login'
import { sharedAddedOfficialAccounts } from '../ai-access/added-accounts'
import { readCodexUsage } from '../codex-usage/client'
import { codexAccountKey } from '../codex-usage/normalize'
import { readClaudeOfficialAccount } from '../ai-access/official-account'
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
import { CodexAppIsolationController } from '../ai-access/codex-app-isolation'
import { CodexIsolationTransport } from '../ai-access/codex-isolation-transport'
import { ApplicationIsolationLeaseController, type ApplicationIsolationLeaseStatus } from '../ai-access/application-isolation-lease'
import { ApplicationIsolationHttpConnectTransport } from '../ai-access/application-isolation-transport'
import { readDiagnosticPathContext } from '../network-diagnostics/electron-probe'
import { domesticDiagnosticUrl } from '../network-diagnostics/service'
import { readLaixinNetworkDiagnosticProxy } from '../tunnel/runtime-owner'

const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 100_000 }) })
/** 配置被别的工具改掉、睡醒后端口变了，都要在客户下次用之前被发现。 */
export const RECOVERY_INTERVAL_MS = 600_000
/** Active leases only: bounded target health reads never rewrite configuration or restart a client. */
export const CODEX_ISOLATION_HEALTH_INTERVAL_MS = 60_000
export const HERMES_ISOLATION_HEALTH_INTERVAL_MS = 60_000
const shellSchema = schema.object({ shell: schema.string({ maxLength: 20 }) })
const providerKeySchema = schema.object({ shell: schema.string({ maxLength: 20 }), provider: schema.string({ maxLength: 20 }), key: schema.string({ maxLength: 512 }) })
const codexMultiModelKeySchema = schema.object({ provider: schema.string({ maxLength: 20 }), key: schema.string({ maxLength: 512 }) })
const codexModeSchema = schema.object({ mode: schema.string({ maxLength: 10 }) })
const codexMultiModelConfigurationSchema = schema.object({ provider: schema.string({ maxLength: 20 }), key: schema.string({ maxLength: 512 }), model: schema.string({ maxLength: 128 }) })
const providerShellSchema = schema.object({ provider: schema.string({ maxLength: 20 }), shell: schema.string({ maxLength: 20 }) })
const configurationTargetSchema = schema.object({ shell: schema.string({ maxLength: 20 }), scope: schema.string({ maxLength: 10 }) })
const providerConfigurationSchema = schema.object({ shell: schema.string({ maxLength: 20 }), provider: schema.string({ maxLength: 20 }), key: schema.string({ maxLength: 512 }), model: schema.string({ maxLength: 128 }) })
// provider 传的是**这次失败针对的**那家；桥上不给可选字段，界面拿不准就传空串走回退。
const remedySchema = schema.object({ shell: schema.string({ maxLength: 20 }), action: schema.string({ maxLength: 20 }), provider: schema.string({ maxLength: 20 }) })

type ModelApiAccessActions = Pick<AiAccessService, 'status' | 'saveProviderKey' | 'useProvider' | 'useOfficial' | 'cancelTests'>
type CodexIsolationActions = Pick<CodexAppIsolationController, 'status' | 'enable' | 'disable' | 'recover' | 'reverify'>
type ClaudeIsolationActions = Pick<ApplicationIsolationLeaseController, 'status' | 'enable' | 'disable' | 'recover' | 'reverify'>
type HermesIsolationActions = Pick<ApplicationIsolationLeaseController, 'status' | 'enable' | 'disable' | 'recover' | 'reverify'>
type ProjectConfigurationDirectoryPicker = () => Promise<string | undefined>
type RestartGuidanceReader = { read(shell: AiAccessShell): Promise<ShellRestartGuidance> }

/** Test-only seams keep the production bridge bound to its fixed local readers. */
export interface AiAccessActionRuntime {
  readonly restartGuidance?: RestartGuidanceReader
  /** Mac 使用回执（API-04）：注入替代生产单例，测试里配 showSaveDialog 验证取消与落盘。 */
  readonly usageReceipt?: UsageReceiptRecorder
  readonly showSaveDialog?: () => Promise<{ readonly canceled: boolean; readonly filePath?: string }>
  /** Test seam only; production always composes the fixed private-session controller below. */
  readonly codexIsolation?: CodexIsolationActions
  /** Test seam only; production binds Claude only to its own private HTTP/CONNECT session. */
  readonly claudeIsolation?: ClaudeIsolationActions
  /** Test seam only; production binds Hermes to its own non-persistent session. */
  readonly hermesIsolation?: HermesIsolationActions
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
  const respondAccessStatus = async (status: Promise<AiAccessStatus>) => respond(publicAiAccessStatus(await status))
  const codexIsolation = runtime.codexIsolation ?? (access === undefined ? productionCodexAppIsolation() : undefined)
  const codexIsolationHealth = codexIsolation === undefined ? undefined : createCodexIsolationHealthScheduler(codexIsolation)
  const claudeIsolation = runtime.claudeIsolation ?? (access === undefined ? productionClaudeAppIsolation() : undefined)
  const claudeIsolationHealth = claudeIsolation === undefined ? undefined : createClaudeIsolationHealthScheduler(claudeIsolation)
  const revokeClaudeIsolation = async (shell: AiAccessShell): Promise<void> => {
    if (shell !== 'claude' || claudeIsolation === undefined) return
    claudeIsolationHealth?.stop()
    const status = await claudeIsolation.disable()
    if (status.code !== 'RESTORED' && status.code !== 'EXTERNAL_VALUE_PRESERVED') throw new Error('CLAUDE_ISOLATION_REVOKE_FAILED')
  }
  const hermesIsolation = runtime.hermesIsolation ?? (access === undefined ? productionHermesAppIsolation() : undefined)
  const hermesIsolationHealth = hermesIsolation === undefined ? undefined : createHermesIsolationHealthScheduler(hermesIsolation)
  const hermesMutations = hermesIsolation === undefined ? undefined : createHermesIsolationMutationGate(hermesIsolation, hermesIsolationHealth)
  if (access === undefined) productionHermesMutationGate = hermesMutations
  const runHermesRouteMutation = <T>(shell: AiAccessShell, task: () => Promise<T>): Promise<T> =>
    shell === 'hermes' && hermesMutations !== undefined ? hermesMutations.runRouteMutation(task) : task()
  const runGatewayRecoveryMutation = <T>(task: () => Promise<T>): Promise<T> =>
    hermesMutations === undefined ? task() : hermesMutations.run(task)
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
  registry.registerAction({ name: 'aiaccess.status', paramsSchema: schema.undefined(), resultSchema,
    handler: () => respondAccessStatus(resolvedAccess.status()) })
  if (codexIsolation !== undefined) {
    registry.registerAction({ name: 'aiaccess.codexIsolationStatus', paramsSchema: schema.undefined(), resultSchema,
      handler: () => respond(publicCodexIsolationStatus(codexIsolation.status())) })
    registry.registerAction({ name: 'aiaccess.enableCodexIsolation', paramsSchema: schema.undefined(), resultSchema,
      handler: async () => {
        const status = await codexIsolation.enable()
        codexIsolationHealth?.observe(status)
        return respond(publicCodexIsolationStatus(status))
      } })
    registry.registerAction({ name: 'aiaccess.disableCodexIsolation', paramsSchema: schema.undefined(), resultSchema,
      handler: async () => {
        codexIsolationHealth?.stop()
        return respond(publicCodexIsolationStatus(await codexIsolation.disable()))
      } })
  }
  if (claudeIsolation !== undefined) {
    registry.registerAction({ name: 'aiaccess.claudeIsolationStatus', paramsSchema: schema.undefined(), resultSchema,
      handler: () => respond(publicClaudeIsolationStatus(claudeIsolation.status())) })
    registry.registerAction({ name: 'aiaccess.enableClaudeIsolation', paramsSchema: schema.undefined(), resultSchema,
      handler: async () => {
        const status = await claudeIsolation.enable()
        claudeIsolationHealth?.observe(status)
        return respond(publicClaudeIsolationStatus(status))
      } })
    registry.registerAction({ name: 'aiaccess.disableClaudeIsolation', paramsSchema: schema.undefined(), resultSchema,
      handler: async () => {
        claudeIsolationHealth?.stop()
        return respond(publicClaudeIsolationStatus(await claudeIsolation.disable()))
      } })
  }
  if (hermesIsolation !== undefined) {
    registry.registerAction({ name: 'aiaccess.hermesIsolationStatus', paramsSchema: schema.undefined(), resultSchema,
      handler: () => respond(publicHermesIsolationStatus(hermesIsolation.status())) })
    registry.registerAction({ name: 'aiaccess.enableHermesIsolation', paramsSchema: schema.undefined(), resultSchema,
      handler: async () => {
        const status = await hermesMutations!.run(() => hermesIsolation.enable())
        hermesIsolationHealth?.observe(status)
        return respond(publicHermesIsolationStatus(status))
      } })
    registry.registerAction({ name: 'aiaccess.disableHermesIsolation', paramsSchema: schema.undefined(), resultSchema,
      handler: async () => {
        return respond(publicHermesIsolationStatus(await hermesMutations!.run(async () => {
          hermesIsolationHealth?.stop()
          return hermesIsolation.disable()
        })))
      } })
  }
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
    handler: async (params) => {
      const input = params as { readonly shell: string; readonly provider: string; readonly key: string }
      const shell = readShell(input.shell)
      await revokeClaudeIsolation(shell)
      return respondAccessStatus(runHermesRouteMutation(shell,
        () => resolvedAccess.saveProviderKey(shell, readProvider(input.provider), input.key)))
    }
  })
    registry.registerAction({
      name: 'aiaccess.useProvider', paramsSchema: providerShellSchema, resultSchema,
      handler: async (params) => {
        const input = params as { readonly provider: string; readonly shell: string }
        const shell = readShell(input.shell)
        await revokeClaudeIsolation(shell)
        return respondAccessStatus(runHermesRouteMutation(shell,
          () => resolvedAccess.useProvider(shell, readProvider(input.provider))))
      }
    })
  registry.registerAction({
    name: 'aiaccess.useOfficial', paramsSchema: shellSchema, resultSchema,
    handler: async (params) => {
      const shell = readShell((params as { readonly shell: string }).shell)
      await revokeClaudeIsolation(shell)
      return respondAccessStatus(runHermesRouteMutation(shell, () => resolvedAccess.useOfficial(shell)))
    }
  })
  const resolvedLogin = codexLogin ?? (access === undefined ? productionCodexLogin(resolvedAccess) : undefined)
  if (resolvedLogin !== undefined) {
    registry.registerAction({ name: 'aiaccess.codexOfficialStatus', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedLogin.status()) })
    registry.registerAction({ name: 'aiaccess.startCodexOfficialLogin', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedLogin.start()) })
    registry.registerAction({ name: 'aiaccess.cancelCodexOfficialLogin', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedLogin.cancel()) })
  }
  const resolvedClaudeLogin = claudeLogin ?? (access === undefined ? productionClaudeLogin(resolvedAccess, () => revokeClaudeIsolation('claude')) : undefined)
  if (resolvedClaudeLogin !== undefined) {
    registry.registerAction({ name: 'aiaccess.claudeOfficialStatus', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedClaudeLogin.status()) })
    registry.registerAction({ name: 'aiaccess.startClaudeOfficialLogin', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedClaudeLogin.start()) })
    registry.registerAction({ name: 'aiaccess.submitClaudeLoginCode', paramsSchema: schema.object({ code: schema.string({ maxLength: 512 }) }), resultSchema, handler: (params) => respond(resolvedClaudeLogin.submitCode((params as { code: string }).code)) })
    registry.registerAction({ name: 'aiaccess.cancelClaudeOfficialLogin', paramsSchema: schema.undefined(), resultSchema, handler: () => respond(resolvedClaudeLogin.cancel()) })
  }
  if (resolvedAccess instanceof AiAccessService) {
    registry.registerAction({ name: 'aiaccess.aiRouterStatus', paramsSchema: schema.undefined(), resultSchema,
      handler: () => respond(resolvedAccess.aiRouterStatus()) })
    registry.registerAction({ name: 'aiaccess.repairCodexMultiModelRouter', paramsSchema: schema.undefined(), resultSchema,
      handler: () => respond(resolvedAccess.repairCodexMultiModelRouter()) })
    registry.registerAction({ name: 'aiaccess.removeCodexMultiModel', paramsSchema: schema.object({ provider: schema.string({ maxLength: 20 }) }), resultSchema,
      handler: params => respond(resolvedAccess.removeCodexMultiModel(readProvider((params as { provider: string }).provider))) })
    registry.registerAction({ name: 'aiaccess.setCodexMode', paramsSchema: codexModeSchema, resultSchema, handler: params => {
      const mode = (params as { mode: string }).mode
      if (mode !== 'single' && mode !== 'multi') throw new Error('AI_ACCESS_CODEX_MODE_INVALID')
      return respond(resolvedAccess.setCodexMode(mode))
    } })
    registry.registerAction({ name: 'aiaccess.configureCodexMultiModel', paramsSchema: codexMultiModelConfigurationSchema, resultSchema, handler: params => {
      const input = params as { provider: string; key: string; model: string }
      return respond(resolvedAccess.configureCodexMultiModel(readProvider(input.provider), input.key, input.model))
    } })
    registry.registerAction({ name: 'aiaccess.verifyAndAddCodexMultiModel', paramsSchema: codexMultiModelKeySchema, resultSchema, handler: params => {
      const input = params as { provider: string; key: string }
      return respond(resolvedAccess.verifyAndAddCodexMultiModel(readProvider(input.provider), input.key))
    } })
    registry.registerAction({ name: 'aiaccess.selectConfigurationTarget', paramsSchema: configurationTargetSchema, resultSchema, handler: async params => {
      const input = params as { shell: string; scope: string }
      if (input.scope !== 'user' && input.scope !== 'project') throw new Error('AI_ACCESS_CONFIGURATION_TARGET_SCOPE_INVALID')
      const shell = readShell(input.shell)
      await revokeClaudeIsolation(shell)
      const scope = input.scope
      return respondAccessStatus(runHermesRouteMutation(shell,
        () => resolvedAccess.selectConfigurationTarget(shell, scope)))
    } })
    registry.registerAction({ name: 'aiaccess.selectConfigurationProject', paramsSchema: shellSchema, resultSchema, handler: async params => {
      const shell = readShell((params as { shell: string }).shell)
      // Native Codex never reads a project provider config. Reject before opening a file picker so
      // a stale renderer or direct bridge call cannot suggest a repair that the client ignores.
      if (shell !== 'claude') throw new Error('AI_ACCESS_CONFIGURATION_TARGET_UNSUPPORTED')
      await revokeClaudeIsolation(shell)
      const projectDir = await (projectDirectoryPicker ?? pickProjectConfigurationDirectory)()
      return respondAccessStatus(projectDir === undefined
        ? resolvedAccess.status()
        : resolvedAccess.selectConfigurationProject(shell, projectDir))
    } })
    registry.registerAction({ name: 'aiaccess.restorePreviousConnection', paramsSchema: shellSchema, resultSchema,
      handler: async params => {
        const shell = readShell((params as { shell: string }).shell)
        await revokeClaudeIsolation(shell)
        return respondAccessStatus(runHermesRouteMutation(shell, () => resolvedAccess.restorePreviousConnection(shell)))
      } })
    registry.registerAction({ name: 'aiaccess.configureProvider', paramsSchema: providerConfigurationSchema, resultSchema, handler: async params => {
      const input = params as { shell: string; provider: string; key: string; model: string }
      const shell = readShell(input.shell)
      await revokeClaudeIsolation(shell)
      return respondAccessStatus(runHermesRouteMutation(shell,
        () => resolvedAccess.configureProvider(shell, readProvider(input.provider), input.key, input.model)))
    } })
    // API-06：快捷 Key 表单的原子入口——候选 Key 先验证，任一步失败都回到原 Key、原模型、原路由。
    registry.registerAction({ name: 'aiaccess.useProviderWithKey', paramsSchema: providerKeySchema, resultSchema,
      handler: async (params) => {
        const input = params as { readonly shell: string; readonly provider: string; readonly key: string }
        const shell = readShell(input.shell)
        await revokeClaudeIsolation(shell)
        return respondAccessStatus(runHermesRouteMutation(shell,
          () => resolvedAccess.useProviderWithKey(shell, readProvider(input.provider), input.key)))
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
    registry.registerAction({ name: 'aiaccess.probeDiagnosticPath',
      paramsSchema: schema.object({ shell: schema.string({ maxLength: 12 }), revision: schema.string({ maxLength: 64 }) }),
      resultSchema, handler: params => {
        const input = params as { shell: string; revision: string }
        return respond(resolvedAccess.probeDiagnosticPath(readShell(input.shell), input.revision))
      } })
    registry.registerAction({ name: 'aiaccess.remedy', paramsSchema: remedySchema, resultSchema, handler: async params => {
      const input = params as { shell: string; action: string; provider: string }
      const software = readShell(input.shell), action = readRemedyAction(input.action)
      const intended = input.provider === '' ? undefined : readProvider(input.provider)
      if (action !== 'openConsole') {
        if (software === 'claude' && (action === 'useOfficial' || action === 'reapply' || action === 'restartGateway')) await revokeClaudeIsolation(software)
        const operation = () => resolvedAccess.remedy(software, action, intended)
        return respond(software === 'hermes' || action === 'restartGateway'
          ? hermesMutations === undefined ? operation() : hermesMutations.runRouteMutation(operation) : operation())
      }
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
    // API-10：服务面板「取消检查」/关闭面板时中止在飞自测请求；不进队列，堵着也能立刻生效。
    registry.registerAction({ name: 'aiaccess.cancelServiceTests', paramsSchema: schema.undefined(), resultSchema,
      handler: () => respond(resolvedAccess.cancelTests()) })
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
      handler: () => respond(runGatewayRecoveryMutation(() => resolvedAccess.recoverAccess('manual'))) })
    if (codexIsolation !== undefined) registry.registerShutdownHook('aiaccess.codex-isolation', () => {
      codexIsolationHealth?.stop()
      return codexIsolation.recover().then(() => undefined)
    })
    if (claudeIsolation !== undefined) registry.registerShutdownHook('aiaccess.claude-isolation', () => {
      claudeIsolationHealth?.stop()
      return claudeIsolation.recover().then(() => undefined)
    })
    if (hermesIsolation !== undefined) registry.registerShutdownHook('aiaccess.hermes-isolation', () => {
      hermesIsolationHealth?.stop()
      return hermesIsolation.recover().then(() => undefined)
    })
    registry.registerShutdownHook('aiaccess.gateway', () => resolvedAccess.stop())
    // No requests to providers and no shell writes occur during restoration.
    const restored = resolvedAccess.initialize()
    void restored
    // 生产合成才起后台核对：重开后先对一次，之后每 10 分钟一次，顺带覆盖唤醒与断网恢复。
    if (access === undefined) {
      void restored.then(async () => {
        await codexIsolation?.recover()
        await claudeIsolation?.recover()
        await hermesIsolation?.recover()
        await runGatewayRecoveryMutation(() => resolvedAccess.recoverAccess('startup'))
      }).catch(() => undefined)
      const timer = setInterval(() => {
        const recover = runGatewayRecoveryMutation(() => resolvedAccess.recoverAccess('periodic'))
        void recover.catch(() => undefined)
      }, RECOVERY_INTERVAL_MS)
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

/** Called only after Desktop's update gate has verified the current HMAC/runtime/seat owner. */
export async function acceptVerifiedProductionAiRouterRecovery(): Promise<void> {
  await productionAiAccessService().acceptVerifiedAiRouterRecovery()
}

let productionCodexIsolation: CodexAppIsolationController | undefined
let productionCodexIsolationTransport: CodexIsolationTransport | undefined
let productionClaudeIsolation: ApplicationIsolationLeaseController | undefined
let productionClaudeIsolationTransport: ApplicationIsolationHttpConnectTransport | undefined
let productionHermesIsolation: ApplicationIsolationLeaseController | undefined
let productionHermesIsolationTransport: ApplicationIsolationHttpConnectTransport | undefined
let productionHermesMutationGate: HermesIsolationMutationGate | undefined
export function productionAiAccessService(): AiAccessService {
  if (productionAccess) return productionAccess
  const home = app.getPath('home')
  const environment = shellInventory().environment()
  const file = createManagedTextFile()
  // The generated Codex catalogue retains trusted Desktop model metadata and can exceed the
  // normal config-file cap. This read-only status adapter uses the same bounded cap as writing.
  const catalogFile = createManagedTextFile({ maxBytes: 4 * 1024 * 1024 })
  // API-11：观察器结果带 10 秒时间窗——登录等待等高频 status 读取不再每轮 spawn profiles＋ps；
  // 窗口过期或观察失败即重查，写路径判定的失效语义见 configuration-execution-observer。
  const observeConfigurationExecution = createConfigurationExecutionObserver({ platform: process.platform, home, ttlMs: configurationObservationTtlMs })
  // Mac 使用回执（API-04）：主进程侧五个固定阶段的白名单记录；⛔ 因记录失败影响主流程。
  const usageReceipt = productionUsageReceiptRecorder()
  const codexIsolationTransport = productionCodexIsolationTransport ??= new CodexIsolationTransport({
    // No `persist:` prefix: the isolated egress holds no cookies, cache or customer login state.
    create: () => session.fromPartition('toolbox-codex-isolation', { cache: false })
  })
  const claudeIsolationTransport = productionClaudeIsolationTransport ??= new ApplicationIsolationHttpConnectTransport({
    // This is deliberately a separate non-persistent session; it never shares Codex cookies, cache or connections.
    create: () => session.fromPartition('toolbox-claude-isolation', { cache: false })
  })
  const hermesIsolationTransport = productionHermesIsolationTransport ??= new ApplicationIsolationHttpConnectTransport({
    // Hermes has a dedicated, non-persistent session and never shares Codex cookies/cache.
    create: () => session.fromPartition('toolbox-hermes-isolation', { cache: false })
  })
  const adapters = createDeepSeekAdapters({
      home,
      platform: process.platform,
      localAppData: environment.LOCALAPPDATA,
      hermesHome: environment.HERMES_HOME,
      // The locator contains only a main-process HERMES_HOME needed to settle an unfinished
      // lease after the environment selects a different target; it never enters state or IPC.
      hermesIsolationRegistryPath: join(app.getPath('userData'), 'ai-access', 'hermes-isolation-targets.json'),
      // No process.cwd(): it is the Toolbox process, not evidence of a customer's project.
      configurationExecution: observedConfigurationExecution(home, process.platform, environment),
      observeConfigurationExecution,
      // The selected project root is retained only in this 0600 main-process file. Status and
      // renderer messages receive target scope/reason evidence, never the customer path.
      projectTargetStore: createProjectConfigurationTargetStore(file, join(app.getPath('userData'), 'ai-access', 'private-project-targets.json'), process.platform),
      // One opaque lease pointer lets restart recovery reject a changed Claude target without
      // inspecting a recorded path or writing the newly selected settings file.
      claudeIsolationLeaseRegistryPath: join(app.getPath('userData'), 'ai-access', 'laixin-claude-isolation-target.json'),
      file
  })
  const codexAdapter = adapters.find(adapter => adapter.shell === 'codex')
  productionAccess = new AiAccessService(
    createAiAccessStore(join(app.getPath('userData'), 'ai-access')),
    adapters,
    // The generic request ledger accepts all native clients; this stricter macOS observer is
    // attached only in production to tell Codex Desktop apart from the CLI without reading data.
    new AiGateway({
      fetch: (input, init, route) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (route?.shell === 'codex' && route.isolated === true) return codexIsolationTransport.fetch(url, init)
        if (route?.shell === 'claude' && route.isolated === true) return claudeIsolationTransport.fetch(url, init)
        if (route?.shell === 'hermes' && route.isolated === true) return hermesIsolationTransport.fetch(url, init)
        return fetch(input, init)
      },
      desktopAttestor: createDesktopRouteAttestor(),
      onUsageEvent: event => usageReceipt.record(gatewayUsageEventToReceipt(event))
    }),
    {
      // Do not block a customer on a CLI version. Stable provider differences are normalized by
      // the gateway capability table; actual trusted-install validation stays in shellInstalled.
      resolveRoute: (shell, provider) => resolveProviderRoute(recipeStore().current(), shell, provider,
        { endpoint: modelProviders[provider].endpoints[shell], model: modelProviders[provider].models[shell] }),
      recordFault,
      // The function is installed by the action composition after the Hermes controller exists.
      // Until then no isolation lease can have been enabled, so a missing gate cannot leave one live.
      beforeHermesRouteMutation: () => productionHermesMutationGate?.releaseForRouteMutation() ?? Promise.resolve(),
      recordUsageEvent: event => usageReceipt.record(event),
      beforeRecoveryRewrite: async shells => {
        if (!shells.includes('claude') || productionClaudeIsolation === undefined) return
        const status = await productionClaudeIsolation.disable()
        if (status.code !== 'RESTORED' && status.code !== 'EXTERNAL_VALUE_PRESERVED') throw new Error('CLAUDE_ISOLATION_REVOKE_FAILED')
      },
      // 真 Key 矩阵只做受信任安装位置的存在性检查。不能为此调用通用盘点，
      // 因为它会执行 PATH 中未知包装器的 --version。
      shellInstalled: async (software) => trustedCliInstalled(software === 'claude' ? 'claude-code' : software,
        process.platform, home, environment),
      saveMatrix: (report) => productionModelMatrixStore().save(report),
      readCodexMultiModelCatalog: async multiModel => {
        const codexHome = await codexAdapter?.codexOfficialLoginRoot?.()
        if (!codexHome) return { state: 'unreadable' }
        return readCodexWorkspaceCatalogStatus({ codexHome, toolboxExecutable: process.execPath, multiModel, file: catalogFile })
      },
      deactivateCodexMultiModel: async commitState => {
        const codexHome = await codexAdapter?.codexOfficialLoginRoot?.()
        if (!codexHome) throw new Error('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
        await deactivateCodexWorkspaceProviders({ codexHome, file: catalogFile }, commitState)
      }
    },
    new AiRouterController(app.getPath('userData'), {
      executable: process.execPath,
      ...(app.isPackaged ? {} : { appPath: app.getAppPath() }),
      logDir: join(app.getPath('userData'), 'logs')
    })
  )
  return productionAccess
}

function productionCodexAppIsolation(): CodexAppIsolationController {
  if (productionCodexIsolation !== undefined) return productionCodexIsolation
  const access = productionAiAccessService()
  const transport = productionCodexIsolationTransport
  if (transport === undefined) throw new Error('CODEX_ISOLATION_TRANSPORT_UNAVAILABLE')
  productionCodexIsolation = new CodexAppIsolationController({
    applicationId: 'codex',
    adapter: access.createCodexIsolationAdapter(transport),
    // This private Electron probe is N-55's read-only path fingerprint: it covers the system
    // proxy/PAC resolution plus active-path evidence before/after, without touching OS settings.
    system: { snapshot: () => readDiagnosticPathContext(domesticDiagnosticUrl) },
    entry: async () => {
      const proxyUrl = readLaixinNetworkDiagnosticProxy()
      return proxyUrl === undefined ? undefined : {
        capability: 'http-connect', id: 'n55-owned-local-entry', proxyUrl
      }
    }
  })
  return productionCodexIsolation
}

function productionClaudeAppIsolation(): ApplicationIsolationLeaseController {
  if (productionClaudeIsolation !== undefined) return productionClaudeIsolation
  const access = productionAiAccessService()
  const transport = productionClaudeIsolationTransport
  if (transport === undefined) throw new Error('CLAUDE_ISOLATION_TRANSPORT_UNAVAILABLE')
  productionClaudeIsolation = new ApplicationIsolationLeaseController({
    applicationId: 'claude',
    adapter: access.createClaudeIsolationAdapter(transport),
    // This N-55 probe is read-only and only guards against a changed system path; it cannot write a proxy, PAC, DNS or route.
    system: { snapshot: () => readDiagnosticPathContext(domesticDiagnosticUrl) },
    entry: async () => {
      const proxyUrl = readLaixinNetworkDiagnosticProxy()
      return proxyUrl === undefined ? undefined : {
        capability: 'http-connect', id: 'n55-owned-local-entry', proxyUrl
      }
    }
  })
  return productionClaudeIsolation
}

function productionHermesAppIsolation(): ApplicationIsolationLeaseController {
  if (productionHermesIsolation !== undefined) return productionHermesIsolation
  const access = productionAiAccessService()
  const transport = productionHermesIsolationTransport
  if (transport === undefined) throw new Error('HERMES_ISOLATION_TRANSPORT_UNAVAILABLE')
  productionHermesIsolation = new ApplicationIsolationLeaseController({
    applicationId: 'hermes',
    adapter: access.createHermesIsolationAdapter(transport),
    // N-55-derived read-only path evidence; this controller has no system write capability.
    system: { snapshot: () => readDiagnosticPathContext(domesticDiagnosticUrl) },
    entry: async () => {
      const proxyUrl = readLaixinNetworkDiagnosticProxy()
      return proxyUrl === undefined ? undefined : {
        capability: 'http-connect', id: 'n55-owned-local-entry', proxyUrl
      }
    }
  })
  return productionHermesIsolation
}

/** The native dialog keeps the raw directory inside the main process; the renderer receives only status evidence. */
async function pickProjectConfigurationDirectory(): Promise<string | undefined> {
  const selected = await dialog.showOpenDialog({ title: '选择项目配置目录', properties: ['openDirectory'] })
  return selected.canceled || selected.filePaths.length !== 1 ? undefined : selected.filePaths[0]
}

function productionCodexLogin(access: ModelApiAccessActions): CodexOfficialLoginController {
  if (!(access instanceof AiAccessService)) throw new Error('AI_ACCESS_SERVICE_INVALID')
  const home = app.getPath('home')
  const addedAccounts = sharedAddedOfficialAccounts()
  const environment = async (): Promise<NodeJS.ProcessEnv> => ({
    ...shellInventory().environment(),
    // Finder-launched Toolbox may not inherit a terminal's CODEX_HOME. The adapter resolves the
    // same verified root used for config.toml and auth.json; it never leaves this login command.
    CODEX_HOME: await access.codexOfficialLoginRoot()
  })
  let loginCommand: { executable: string; args: readonly string[]; environment?: NodeJS.ProcessEnv } | undefined
  return new CodexOfficialLoginController({
    findCommand: async () => {
      const commandEnvironment = await environment()
      const executable = await trustedCliExecutable('codex', process.platform, home, commandEnvironment)
      const command = executable === undefined ? null : { executable, args: ['app-server', '--listen', 'stdio://'] as readonly string[], environment: commandEnvironment }
      loginCommand = command ?? undefined
      return command
    },
    startLogin: (command) => startCodexChatGptLogin(command, { cwd: home, openExternal: (url) => shell.openExternal(url) }),
    useOfficial: async (software) => {
      await access.useOfficial(software)
      // 登录完成即由主进程登记账号指纹：这是「已添加账号」的唯一来源，之后用量只对在案账号读取。
      // 登记失败不回滚登录本身——客户再登录一次就会重新登记。
      try {
        const command = loginCommand
        if (command) {
          const { account } = await readCodexUsage(
            { executable: command.executable, args: command.args },
            { cwd: home, signal: new AbortController().signal, accountOnly: true, env: command.environment }
          )
          await addedAccounts.mark('codex', codexAccountKey(account))
        }
      } catch { /* 登记失败保持未登记态：用量保持门控，重新登录可修复 */ }
    }
  })
}

function productionClaudeLogin(access: ModelApiAccessActions, releaseIsolation?: () => Promise<void>): ClaudeOfficialLoginController {
  if (!(access instanceof AiAccessService)) throw new Error('AI_ACCESS_SERVICE_INVALID')
  const home = app.getPath('home')
  const addedAccounts = sharedAddedOfficialAccounts()
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
    useOfficial: async (software) => {
      await releaseIsolation?.()
      await access.useOfficial(software)
      // 与 Codex 一致：登录完成即由主进程登记账号指纹，之后身份与用量只对在案账号读取。
      try {
        const executable = await trustedCliExecutable('claude-code', process.platform, home, environment())
        if (executable) {
          const account = await readClaudeOfficialAccount(executable, home, environment())
          if (account.state === 'signed-in' && account.accountKey) await addedAccounts.mark('claude', account.accountKey)
        }
      } catch { /* 登记失败保持未登记态：用量保持门控，重新登录可修复 */ }
    }
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

function createApplicationIsolationHealthScheduler(isolation: Pick<ApplicationIsolationLeaseController, 'reverify'>, intervalMs: number): {
  observe(value: { readonly available: boolean }): void
  stop(): void
} {
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  return {
    observe: value => {
      if (!value.available) { stop(); return }
      if (timer !== undefined) return
      timer = setInterval(() => {
        void isolation.reverify().then(next => { if (!next.available) stop() }, () => stop())
      }, intervalMs)
      timer.unref?.()
    },
    stop
  }
}

function createCodexIsolationHealthScheduler(isolation: Pick<CodexAppIsolationController, 'reverify'>): {
  observe(value: { readonly available: boolean }): void
  stop(): void
} {
  return createApplicationIsolationHealthScheduler(isolation, CODEX_ISOLATION_HEALTH_INTERVAL_MS)
}

function createClaudeIsolationHealthScheduler(isolation: Pick<ApplicationIsolationLeaseController, 'reverify'>, intervalMs = CODEX_ISOLATION_HEALTH_INTERVAL_MS): {
  observe(value: { readonly available: boolean }): void
  stop(): void
} {
  return createApplicationIsolationHealthScheduler(isolation, intervalMs)
}

function createHermesIsolationHealthScheduler(isolation: Pick<ApplicationIsolationLeaseController, 'reverify'>): {
  observe(value: { readonly available: boolean }): void
  stop(): void
} {
  return createApplicationIsolationHealthScheduler(isolation, HERMES_ISOLATION_HEALTH_INTERVAL_MS)
}

/**
 * Serializes a Hermes configuration mutation with enable/disable.  The service owns the exact
 * write point, while bridge actions acquire this gate first so an enable cannot appear between
 * release and the route/configuration write.
 */
interface HermesIsolationMutationGate {
  run<T>(task: () => Promise<T>): Promise<T>
  runRouteMutation<T>(task: () => Promise<T>): Promise<T>
  releaseForRouteMutation(): Promise<void>
}

function createHermesIsolationMutationGate(
  isolation: Pick<ApplicationIsolationLeaseController, 'disable'>,
  health: { stop(): void } | undefined
): HermesIsolationMutationGate {
  let pending: Promise<void> = Promise.resolve()
  let taskActive = false
  let releasedInTask = false
  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const result = pending.then(async () => {
      taskActive = true
      releasedInTask = false
      try { return await task() } finally { taskActive = false; releasedInTask = false }
    })
    pending = result.then(() => undefined, () => undefined)
    return result
  }
  const releaseForRouteMutation = async (): Promise<void> => {
    if (taskActive && releasedInTask) return
    health?.stop()
    const status = publicHermesIsolationStatus(await isolation.disable())
    if (status.available || status.mode !== 'disabled' || status.code === 'RESTORE_FAILED') {
      throw new Error('HERMES_ISOLATION_RELEASE_FAILED')
    }
    if (taskActive) releasedInTask = true
  }
  return {
    run,
    runRouteMutation: task => run(async () => {
      await releaseForRouteMutation()
      return task()
    }),
    releaseForRouteMutation
  }
}

/** Fixed isolation IPC vocabulary: no local endpoint, configuration, keys or raw exception crosses this boundary. */
function publicApplicationIsolationStatus(application: ApplicationIsolationLeaseStatus['application'], value: unknown): Readonly<Record<string, string | boolean | number>> {
  const modes = ['application-only', 'disabled'] as const
  const phases = ['idle', 'configuring', 'verifying', 'available', 'restoring', 'restored', 'limited'] as const
  const actions = ['idle', 'enable', 'disable', 'recover', 'health'] as const
  const codes = ['AVAILABLE', 'RESTORED', 'EXTERNAL_VALUE_PRESERVED', 'ENTRY_UNAVAILABLE', 'CONFIG_PATH_UNKNOWN', 'CONFIG_WRITE_FAILED', 'CONFIG_READBACK_MISMATCH', 'TARGET_UNREACHABLE', 'SYSTEM_NETWORK_CHANGED', 'RESTORE_FAILED', 'STALE_OPERATION'] as const
  if (!record(value) || value.application !== application || value.scope !== 'model-api-egress' || value.capability !== 'http-connect' || !isOneOf(value.mode, modes) || value.systemNetwork !== 'unmanaged' ||
    !isOneOf(value.phase, phases) || !isOneOf(value.action, actions) || !Number.isSafeInteger(value.intentGeneration) ||
    (value.intentGeneration as number) < 0 || typeof value.available !== 'boolean' || !isOneOf(value.code, codes)) {
    throw new Error('APPLICATION_ISOLATION_STATUS_INVALID')
  }
  if (!isCoherentIsolationStatus(value)) throw new Error('APPLICATION_ISOLATION_STATUS_INVALID')
  return {
    application, scope: 'model-api-egress', capability: 'http-connect', mode: value.mode, systemNetwork: 'unmanaged', phase: value.phase,
    action: value.action, intentGeneration: value.intentGeneration as number, available: value.available, code: value.code
  }
}

function publicCodexIsolationStatus(value: unknown): Readonly<Record<string, string | boolean | number>> {
  return publicApplicationIsolationStatus('codex', value)
}

function publicClaudeIsolationStatus(value: unknown): Readonly<Record<string, string | boolean | number>> {
  return publicApplicationIsolationStatus('claude', value)
}

function publicHermesIsolationStatus(value: unknown): Readonly<Record<string, string | boolean | number>> {
  return publicApplicationIsolationStatus('hermes', value)
}

/** Hermes isolation never needs the target path to state a safe refusal; keep HERMES_HOME out of IPC. */
function publicAiAccessStatus(value: AiAccessStatus): AiAccessStatus {
  const hermes = value.configurationTargets?.hermes
  const redactedHermes = hermes?.symlink === undefined ? undefined : {
    shell: hermes.shell, scope: hermes.scope, override: hermes.override, writable: hermes.writable,
    ...(hermes.reason === undefined ? {} : { reason: hermes.reason })
  }
  // A configuration-target rejection may also be cached as an attempt notice. Never forward
  // its former path-bearing text merely because the target itself was redacted above.
  const redactedAttempt = value.attempt?.shell === 'hermes' && value.attempt.notice !== undefined
    ? { ...value.attempt, notice: 'Hermes 的有效受控配置无法确认；没有改写任何配置。' } : undefined
  if (redactedHermes === undefined && redactedAttempt === undefined) return value
  return {
    ...value,
    ...(redactedAttempt === undefined ? {} : { attempt: redactedAttempt }),
    ...(redactedHermes === undefined ? {} : { configurationTargets: { ...value.configurationTargets, hermes: redactedHermes } })
  }
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

/** `available` is a verified lease state, never a free-standing UI boolean. */
function isCoherentIsolationStatus(value: Record<string, unknown>): boolean {
  if (value.available === true) return value.mode === 'application-only' && value.phase === 'available' && value.code === 'AVAILABLE'
  if (value.code === 'AVAILABLE') return value.mode === 'application-only' &&
    (value.phase === 'configuring' || value.phase === 'verifying' || value.phase === 'restoring')
  if (value.code === 'RESTORED' || value.code === 'EXTERNAL_VALUE_PRESERVED') return value.mode === 'disabled' &&
    (value.phase === 'idle' || value.phase === 'restoring' || value.phase === 'restored')
  return value.mode === 'application-only' && value.phase === 'limited'
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
