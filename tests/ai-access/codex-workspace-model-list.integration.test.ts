import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installCodexWorkspaceProviders } from '../../app/main/ai-access/codex-workspace-config'
import { readCodexWorkspaceOfficialModels } from '../../app/main/ai-access/codex-workspace-launcher'
import { createManagedTextFile } from '../../app/main/ai-access/file'

const currentCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
const runWithCurrentCodex = existsSync(currentCodex) ? describe : describe.skip
let root = ''

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = '' })

runWithCurrentCodex('current Codex app-server model/list', () => {
  it('合并池后保持可见官方模型的公开目录语义', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-codex-app-server-'))
    // Match the trusted Desktop command used by production, not the gateway's HTTP surface.
    const command = { executable: currentCodex, args: ['app-server', '--listen', 'stdio://'] }
    const beforeVisible = await appServerModelList(command, root, false)
    const beforeAll = await appServerModelList(command, root, true)
    const officialModels = await readCodexWorkspaceOfficialModels(command, { cwd: root, timeoutMs: 15_000 })
    const pickerModels = ['laixin.deepseek.deepseek-flash', 'laixin.zhipu-api.glm-5.3-flash']
    await installCodexWorkspaceProviders({
      codexHome: root,
      toolboxExecutable: '/usr/bin/printf',
      multiModel: { baseUrl: 'http://127.0.0.1:43210/codex/multi/v1', model: pickerModels[0], models: pickerModels },
      officialModels,
      file: createManagedTextFile({ maxBytes: 4 * 1024 * 1024 })
    })

    const afterVisible = await appServerModelList(command, root, false)
    const afterAll = await appServerModelList(command, root, true)
    const officialVisible = beforeVisible.filter(model => !model.id.startsWith('laixin.'))
    const officialAll = beforeAll.filter(model => !model.id.startsWith('laixin.'))

    expect(publicModels(afterVisible, officialVisible.map(model => model.id))).toEqual(officialVisible)
    expect(publicModels(afterAll, officialAll.map(model => model.id))).toEqual(officialAll)
    expect(afterAll.filter(model => model.id.startsWith('laixin.')).map(model => model.id)).toEqual(pickerModels)
    expect(afterVisible.filter(model => model.id.startsWith('laixin.')).map(model => model.id)).toEqual(pickerModels)

    const astra = afterAll.find(model => model.id === 'gpt-6-astra')
    expect(astra).toMatchObject({
      displayName: 'GPT-6-Astra',
      inputModalities: ['text', 'image'],
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }
      ]
    })
  })

  it('合并池后仍隐藏官方辅助模型', async () => {
    root = await mkdtemp(join(tmpdir(), 'laixin-codex-app-server-hidden-'))
    const command = { executable: currentCodex, args: ['app-server', '--listen', 'stdio://'] }
    const officialModels = await readCodexWorkspaceOfficialModels(command, { cwd: root, timeoutMs: 15_000 })
    const pickerModels = ['laixin.deepseek.deepseek-flash', 'laixin.zhipu-api.glm-5.3-flash']
    const beforeAll = await appServerModelList(command, root, true)
    const autoReviewBefore = beforeAll.find(model => model.id === 'codex-auto-review')
    expect(autoReviewBefore?.hidden).toBe(true)

    await installCodexWorkspaceProviders({
      codexHome: root,
      toolboxExecutable: '/usr/bin/printf',
      multiModel: { baseUrl: 'http://127.0.0.1:43210/codex/multi/v1', model: pickerModels[0], models: pickerModels },
      officialModels,
      file: createManagedTextFile({ maxBytes: 4 * 1024 * 1024 })
    })

    const afterVisible = await appServerModelList(command, root, false)
    const afterAll = await appServerModelList(command, root, true)
    expect(afterVisible.some(model => model.id === 'codex-auto-review')).toBe(false)
    expect(afterAll.find(model => model.id === 'codex-auto-review')).toMatchObject({ hidden: true })
  })
})

interface AppServerModel {
  readonly id: string
  readonly model: string
  readonly displayName: string
  readonly description: string
  readonly hidden: boolean
  readonly supportedReasoningEfforts: readonly { readonly reasoningEffort: string, readonly description: string }[]
  readonly defaultReasoningEffort: string
  readonly inputModalities: readonly string[]
  readonly multiAgentVersion: string | null
  readonly additionalSpeedTiers: readonly string[]
  readonly serviceTiers: readonly { readonly id: string, readonly name: string, readonly description: string }[]
  readonly defaultServiceTier: string | null
}

function publicModels(models: readonly AppServerModel[], ids: readonly string[]): AppServerModel[] {
  const byId = new Map(models.map(model => [model.id, model]))
  return ids.map(id => {
    const model = byId.get(id)
    if (model === undefined) throw new Error(`missing official model ${id}`)
    return model
  })
}

async function appServerModelList(command: { readonly executable: string, readonly args: readonly string[] }, codexHome: string, includeHidden: boolean): Promise<readonly AppServerModel[]> {
  const child = spawn(command.executable, [...command.args], {
    cwd: codexHome,
    env: { ...process.env, CODEX_HOME: codexHome },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  let buffer = ''
  let finished = false
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  let resolveModels: (models: readonly AppServerModel[]) => void = () => undefined
  let rejectModels: (error: Error) => void = () => undefined
  const result = new Promise<readonly AppServerModel[]>((resolve, reject) => { resolveModels = resolve; rejectModels = reject })
  const timeout = setTimeout(() => finish(new Error('APP_SERVER_TIMEOUT')), 15_000)
  const finish = (error?: Error, models?: readonly AppServerModel[]): void => {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    if (error !== undefined) rejectModels(error)
    else resolveModels(models ?? [])
  }
  const send = (message: Record<string, unknown>): void => { if (!finished) child.stdin.write(`${JSON.stringify(message)}\n`) }
  const fail = (): void => finish(new Error('APP_SERVER_PROTOCOL_INVALID'))

  child.on('error', () => finish(new Error('APP_SERVER_UNAVAILABLE')))
  child.stdin.on('error', () => finish(new Error('APP_SERVER_UNAVAILABLE')))
  child.on('close', () => finish(new Error('APP_SERVER_UNAVAILABLE')))
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (finished) return
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (!line.trim()) continue
      let message: Record<string, unknown> | undefined
      try { message = object(JSON.parse(line)) } catch { /* fail below */ }
      if (message === undefined) { fail(); return }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } })
        continue
      }
      if (message.id === 1) {
        if (message.error !== undefined) { fail(); return }
        send({ method: 'initialized' })
        send({ id: 2, method: 'model/list', params: { includeHidden } })
        continue
      }
      if (message.id !== 2 || message.error !== undefined) { if (message.id === 2) fail(); continue }
      const data = object(message.result)?.data
      if (!Array.isArray(data)) { fail(); return }
      const parsedModels = data.map(parseModel)
      if (parsedModels.some((model): model is undefined => model === undefined) || parsedModels.length === 0) { fail(); return }
      finish(undefined, parsedModels.filter((model): model is AppServerModel => model !== undefined))
      return
    }
  })
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'laixin_catalog_test', title: 'Laixin catalog test', version: '0.5.20' }, capabilities: null } })
  try {
    return await result
  } finally {
    clearTimeout(timeout)
    finished = true
    child.stdin.end()
    child.kill('SIGTERM')
    await closed
  }
}

function parseModel(value: unknown): AppServerModel | undefined {
  const item = object(value)
  const efforts = Array.isArray(item?.supportedReasoningEfforts) ? item.supportedReasoningEfforts.map(object) : undefined
  const tiers = Array.isArray(item?.serviceTiers) ? item.serviceTiers.map(object) : undefined
  if (item === undefined || !string(item.id) || !string(item.model) || !string(item.displayName) || !string(item.description) ||
    typeof item.hidden !== 'boolean' || !string(item.defaultReasoningEffort) || !stringArray(item.inputModalities) ||
    !stringArray(item.additionalSpeedTiers) || !nullableString(item.multiAgentVersion) || !nullableString(item.defaultServiceTier) ||
    efforts === undefined || tiers === undefined || efforts.some(effort => !string(effort?.reasoningEffort) || !string(effort?.description)) ||
    tiers.some(tier => !string(tier?.id) || !string(tier?.name) || !string(tier?.description))) return undefined
  return item as unknown as AppServerModel
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function string(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function nullableString(value: unknown): value is string | null { return value === null || typeof value === 'string' }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(string) }
