// 隐形状态扫描的桥入口。
// 结果一律走 `{ snapshot: JSON }`，与 aiaccess.* 其余动作同一口径。
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { BridgeRegistry } from '../bridge/bridge-registry'
import { schema } from '../bridge/schema'
import { claudeConfigPath, scanHiddenState, type HiddenStateDeps, type HiddenStateFinding, type HiddenStateReport } from '../ai-access/hidden-state'
import {
  cleanRegistryEnv, cleanShellExports, markClaudeOnboarded, restoreClaudeOnboarding, restoreRegistryEnv, restoreShellExports,
  type ClaudeOnboardingEntry, type CleanupFailure, type Exec, type RegistryCleanupEntry, type RegistryCleanupReceipt,
  type RestoreResult, type ShellCleanupEntry, type ShellCleanupReceipt, type WriteFile
} from '../ai-access/hidden-state-cleanup'

const execFile = promisify(execFileCallback)
const resultSchema = schema.object({ snapshot: schema.string({ maxLength: 200_000 }) })
// ids 是扫描结果里那串凭据的 JSON 数组；空串＝这次能处理的全处理。
const cleanSchema = schema.object({ ids: schema.string({ maxLength: 20_000 }) })
const restoreSchema = schema.object({ receipt: schema.string({ maxLength: 200_000 }) })

export interface HiddenStateActionDeps extends HiddenStateDeps {
  readonly backupDir: string
  readonly writeFile?: WriteFile
}

/** The private receipt contains original shell lines, which may contain an API Key. It never crosses IPC. */
interface PrivateHiddenStateCleanReceipt {
  readonly version: 1
  readonly at: string
  readonly shell: ShellCleanupReceipt
  readonly registry: RegistryCleanupReceipt
  readonly claude: readonly ClaudeOnboardingEntry[]
  readonly failures: readonly CleanupFailure[]
  readonly notes: readonly string[]
  /** 真正处理掉了几条。界面按这个说话，**⛔ 把「点了清理」当成「清理好了」**。 */
  readonly cleaned: number
}

/**
 * The renderer only gets the token and recovery metadata it needs to show the result and offer
 * undo. `originalLine`/`commentedLine` remain in the main-process receipt map, so a Key cannot
 * be exposed simply by pressing "停用这一条".
 */
export interface HiddenStateCleanReceipt {
  readonly version: 1
  readonly receiptId: string
  readonly at: string
  readonly shell: Readonly<{
    readonly entries: readonly Pick<ShellCleanupEntry, 'source' | 'backupPath' | 'name' | 'line'>[]
    readonly failures: readonly CleanupFailure[]
    readonly notes: readonly string[]
  }>
  readonly registry: Readonly<{
    readonly entries: readonly Pick<RegistryCleanupEntry, 'key' | 'name' | 'backupPath'>[]
    readonly failures: readonly CleanupFailure[]
    readonly notes: readonly string[]
  }>
  readonly claude: readonly Pick<ClaudeOnboardingEntry, 'path' | 'backupPath' | 'changed'>[]
  readonly failures: readonly CleanupFailure[]
  readonly notes: readonly string[]
  readonly cleaned: number
}

export interface HiddenStateRestoreOutcome {
  readonly results: readonly RestoreResult[]
  readonly notes: readonly string[]
}

/** 界面只传得回凭据，所以清理前先重扫一遍：中间客户自己改过，就该按新的来。 */
async function selected(deps: HiddenStateActionDeps, ids: readonly string[]): Promise<readonly HiddenStateFinding[]> {
  const report = await scanHiddenState(deps)
  const cleanable = report.findings.filter((finding) => finding.cleanable)
  return ids.length === 0 ? cleanable : cleanable.filter((finding) => ids.includes(finding.id))
}

function readIds(raw: string): readonly string[] {
  if (raw.trim() === '') return []
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('HIDDEN_STATE_IDS_INVALID')
  return value as readonly string[]
}

export async function cleanHiddenState(deps: HiddenStateActionDeps, ids: readonly string[]): Promise<PrivateHiddenStateCleanReceipt> {
  const findings = await selected(deps, ids)
  const at = deps.now?.() ?? new Date()
  const fileDeps = { backupDir: deps.backupDir, readFile: deps.readFile, writeFile: deps.writeFile, now: () => at }
  const shell = await cleanShellExports(findings, fileDeps)
  const registry = findings.some((finding) => finding.kind === 'registry_env') && deps.exec !== undefined
    ? await cleanRegistryEnv(findings, { backupDir: deps.backupDir, exec: deps.exec, now: () => at })
    : emptyRegistryReceipt(at)

  const claude: ClaudeOnboardingEntry[] = []
  const failures: CleanupFailure[] = [...shell.failures, ...registry.failures]
  const path = claudeConfigPath(deps.home, deps.env)
  if (findings.some((finding) => finding.kind === 'claude_onboarding' && finding.source === path)) {
    try {
      claude.push(await markClaudeOnboarded(path, fileDeps))
    } catch (error) {
      failures.push({ source: path, name: 'hasCompletedOnboarding', reason: error instanceof Error ? error.message : '写入失败' })
    }
  }

  const cleaned = shell.entries.length + registry.entries.length + claude.filter((entry) => entry.changed).length
  return {
    version: 1, at: at.toISOString(), shell, registry, claude, failures, cleaned,
    notes: [...new Set([...shell.notes, ...registry.notes])]
  }
}

export async function restoreHiddenState(deps: HiddenStateActionDeps, receipt: PrivateHiddenStateCleanReceipt): Promise<HiddenStateRestoreOutcome> {
  const fileDeps = { readFile: deps.readFile, writeFile: deps.writeFile }
  const results: RestoreResult[] = [...await restoreShellExports(receipt.shell, fileDeps)]
  if (receipt.registry.entries.length > 0 && deps.exec !== undefined) {
    results.push(...await restoreRegistryEnv(receipt.registry, { exec: deps.exec }))
  }
  for (const entry of receipt.claude) results.push(await restoreClaudeOnboarding(entry, fileDeps))
  return { results, notes: receipt.notes }
}

function emptyRegistryReceipt(at: Date): RegistryCleanupReceipt {
  return { version: 1, at: at.toISOString(), entries: [], failures: [], notes: [] }
}

function readReceiptId(raw: string): string {
  const value = JSON.parse(raw) as { readonly version?: unknown; readonly receiptId?: unknown }
  if (value?.version !== 1 || typeof value.receiptId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.receiptId)) {
    throw new Error('HIDDEN_STATE_RECEIPT_INVALID')
  }
  return value.receiptId
}

/**
 * 由派工窗口一行接入即可；本文件同时导出 `registerActions`，
 * `app/main/index.ts` 的动作发现（`import.meta.glob('./actions/*.ts')`）会自动带上，⛔ 需要改任何 index。
 */
export function registerHiddenStateActions(registry: BridgeRegistry, deps?: HiddenStateActionDeps): void {
  const resolve = (): HiddenStateActionDeps => deps ?? productionHiddenStateDeps()
  const receipts = new Map<string, PrivateHiddenStateCleanReceipt>()
  registry.registerAction({
    name: 'aiaccess.hiddenState.scan', paramsSchema: schema.undefined(), resultSchema,
    handler: async (): Promise<{ snapshot: string }> => respond(await scanHiddenState(resolve()))
  })
  registry.registerAction({
    name: 'aiaccess.hiddenState.clean', paramsSchema: cleanSchema, resultSchema,
    handler: async (params): Promise<{ snapshot: string }> => {
      const receipt = await cleanHiddenState(resolve(), readIds((params as { readonly ids: string }).ids))
      const receiptId = randomUUID()
      receipts.set(receiptId, receipt)
      while (receipts.size > 20) receipts.delete(receipts.keys().next().value as string)
      return respond(publicCleanReceipt(receiptId, receipt))
    }
  })
  registry.registerAction({
    name: 'aiaccess.hiddenState.restore', paramsSchema: restoreSchema, resultSchema,
    handler: async (params): Promise<{ snapshot: string }> => {
      const receiptId = readReceiptId((params as { readonly receipt: string }).receipt)
      const receipt = receipts.get(receiptId)
      if (receipt === undefined) throw new Error('HIDDEN_STATE_RECEIPT_NOT_AVAILABLE')
      return respond(await restoreHiddenState(resolve(), receipt))
    }
  })
}

function publicCleanReceipt(receiptId: string, value: PrivateHiddenStateCleanReceipt): HiddenStateCleanReceipt {
  return {
    version: 1, receiptId, at: value.at, cleaned: value.cleaned, failures: value.failures, notes: value.notes,
    shell: {
      entries: value.shell.entries.map(({ source, backupPath, name, line }) => ({ source, backupPath, name, line })),
      failures: value.shell.failures, notes: value.shell.notes
    },
    registry: {
      entries: value.registry.entries.map(({ key, name, backupPath }) => ({ key, name, backupPath })),
      failures: value.registry.failures, notes: value.registry.notes
    },
    claude: value.claude.map(({ path, backupPath, changed }) => ({ path, backupPath, changed }))
  }
}

function respond(value: HiddenStateReport | HiddenStateCleanReceipt | HiddenStateRestoreOutcome): { readonly snapshot: string } {
  return { snapshot: JSON.stringify(value) }
}

let productionDeps: HiddenStateActionDeps | undefined
export function productionHiddenStateDeps(): HiddenStateActionDeps {
  productionDeps ??= {
    platform: process.platform,
    home: app.getPath('home'),
    env: process.env,
    exec: productionExec,
    backupDir: join(app.getPath('userData'), 'hidden-state-backups')
  }
  return productionDeps
}

const productionExec: Exec = async (command, args) =>
  (await execFile(command, [...args], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout

export function registerActions(registry: BridgeRegistry): void {
  registerHiddenStateActions(registry)
}
