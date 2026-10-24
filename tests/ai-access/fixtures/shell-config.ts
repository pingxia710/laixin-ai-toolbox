import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { vi } from 'vitest'
import { createDeepSeekAdapters } from '../../../app/main/ai-access/adapters'
import type { ConfigurationExecutionContext } from '../../../app/main/ai-access/configuration-target'
import type { ConfigurationExecutionObservation } from '../../../app/main/ai-access/configuration-execution-observer'
import { AiGateway } from '../../../app/main/ai-access/gateway'
import { AiAccessService, type AiAccessExtras, type AiAccessState } from '../../../app/main/ai-access/service'
import type { ManagedTextFile } from '../../../app/main/ai-access/deepseek-config'
import type { FaultInput } from '../../../app/main/diagnostics/fault-log'

/** 桩上游：探测的两次请求都按壳的原生协议回 OK。 */
function reply(shell: 'codex' | 'claude' | 'hermes', second: boolean): Response {
  if (second) {
    const frames = shell === 'codex' ? [{ type: 'response.output_text.delta', delta: 'OK' }, { type: 'response.completed', response: { status: 'completed' } }]
      : shell === 'claude' ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }, { type: 'message_stop' }]
        : [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }]
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  const body = shell === 'codex' ? { status: 'completed', output: [{ type: 'function_call', call_id: 'probe-1', name: 'toolbox_probe', arguments: '{}' }] }
    : shell === 'claude' ? { type: 'message', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'probe-1', name: 'toolbox_probe', input: {} }] }
      : { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe-1', type: 'function', function: { name: 'toolbox_probe', arguments: '{}' } }] } }] }
  return Response.json(body)
}

/**
 * 用真实的三壳适配器 + 内存配置文件搭一套完整接入：
 * 配置文本、托管块、指纹都是真的，只有上游与 Hermes 命令行是桩。
 */
interface ShellConfigFixtureOptions {
  readonly hermesHome?: string
  readonly configurationExecution?: Readonly<Partial<Record<'hermes', ConfigurationExecutionContext>>>
  readonly observeConfigurationExecution?: () => Promise<ConfigurationExecutionObservation>
}

export function shellConfigFixture(
  initial: AiAccessState = { version: 1, selected: {} },
  extras: Partial<AiAccessExtras> = {},
  options: ShellConfigFixtureOptions = {}
) {
  const home = mkdtempSync(join(tmpdir(), 'laixin-fault-r2-'))
  const data = new Map<string, string>()
  const file: ManagedTextFile = {
    read: async (path) => data.get(path),
    write: async (path, contents) => { data.set(path, contents) },
    remove: async (path) => { data.delete(path) },
    list: async () => [],
    withConfigWriteLock: async (_lockPath, task) => task()
  }
  const hermesSettings = new Map<string, string>()
  let hermesRunFailureAt: number | undefined
  let hermesExternalChangeAfterRun: { readonly at: number; readonly key: string; readonly value: string } | undefined
  let hermesRunCount = 0
  const hermesRunRoots: string[] = []
  const configuredHermesPath = options.configurationExecution?.hermes?.userConfigPath
  const hermesRoot = configuredHermesPath === undefined ? options.hermesHome ?? join(home, '.hermes') : dirname(configuredHermesPath)
  const hermesConfigPath = join(hermesRoot, 'config.yaml')
  const syncHermesConfig = (root = hermesRoot) => {
    const lines = ['model:']
    for (const key of ['provider', 'default', 'base_url', 'api_key', 'api_mode', 'context_length']) {
      const value = hermesSettings.get(`model.${key}`)
      if (value !== undefined) lines.push(`  ${key}: ${JSON.stringify(value)}`)
    }
    data.set(join(root, 'config.yaml'), `${lines.join('\n')}\n`)
  }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const endpoint = String(url)
    const shell = endpoint.endsWith('/responses') ? 'codex' : endpoint.endsWith('/messages') ? 'claude' : 'hermes'
    return reply(shell, JSON.parse(String(init?.body)).stream === true)
  })
  const adapters = createDeepSeekAdapters({
    home, platform: 'darwin', file, hermesHome: options.hermesHome, configurationExecution: options.configurationExecution,
    observeConfigurationExecution: options.observeConfigurationExecution,
    findHermesCommand: async () => 'hermes',
    runHermes: async (_command, args, root) => {
      hermesRunCount++
      hermesRunRoots.push(root ?? hermesRoot)
      if (args[0] === 'config' && args[1] === 'set') hermesSettings.set(args[2], args[3])
      // 真实 hermes ≥0.21 语义：unset 本就未设置的键以非零退出（"Config key not set"）。
      if (args[0] === 'config' && args[1] === 'unset') {
        if (!hermesSettings.has(args[2])) throw new Error(`Config key not set: ${args[2]}`)
        hermesSettings.delete(args[2])
      }
      syncHermesConfig(root)
      if (hermesRunFailureAt === hermesRunCount) throw new Error('fixture hermes config write failed')
      if (hermesExternalChangeAfterRun?.at === hermesRunCount) {
        hermesSettings.set(hermesExternalChangeAfterRun.key, hermesExternalChangeAfterRun.value)
        syncHermesConfig(root)
      }
    },
    readHermesConfig: async (_command, key) => hermesSettings.get(key)
  })
  let state = initial
  const store = { read: async () => state, write: async (next: AiAccessState) => { state = next } }
  const faults: FaultInput[] = []
  const gateway = new AiGateway({ fetch: fetcher, timeoutMs: 1000 })
  const service = new AiAccessService(store, adapters, gateway, { recordFault: (fault) => { faults.push(fault) }, ...extras })
  return {
    home, file, data, hermesSettings, hermesConfigPath, syncHermesConfig, fetcher, gateway, service, store, faults, adapters,
    failHermesWriteAt(relativeCall: number) { hermesRunFailureAt = hermesRunCount + relativeCall },
    changeHermesAfterWriteAt(relativeCall: number, key: string, value: string) {
      hermesExternalChangeAfterRun = { at: hermesRunCount + relativeCall, key, value }
    },
    hermesRunCount: () => hermesRunCount,
    hermesRunRoots: () => [...hermesRunRoots],
    state: () => state,
    codexPath: join(home, '.codex', 'config.toml'),
    claudePath: join(home, '.claude', 'settings.json'),
    async dispose() { await service.stop(); rmSync(home, { recursive: true, force: true }) }
  }
}
