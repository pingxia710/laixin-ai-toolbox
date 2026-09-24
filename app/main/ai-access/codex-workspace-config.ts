import { dirname, join } from 'node:path'
import { modelProviders } from '../../shared/model-providers'
import { parseCodexTomlDocument } from './codex-toml-document'
import type { ManagedTextFile } from './deepseek-config'
import { replaceConfigurationTransaction, withConfigWriteLock } from './config-write-guard'
import { codexWorkspaceSources, type CodexApiWorkspaceSourceId } from './codex-workspace-sources'

const managedBegin = '# >>> Laixin AI Toolbox managed Codex workspaces >>>'
const managedEnd = '# <<< Laixin AI Toolbox managed Codex workspaces <<<'
const apiSources: readonly CodexApiWorkspaceSourceId[] = ['deepseek', 'moonshot', 'zhipu-api']

export interface CodexWorkspaceConfigOptions {
  readonly codexHome: string
  readonly toolboxExecutable: string
  readonly file: ManagedTextFile
}

/**
 * Registers provider definitions without changing Codex's global model/model_provider. Each new
 * thread chooses its provider explicitly, so official login and existing threads keep their route.
 */
export async function installCodexWorkspaceProviders(options: CodexWorkspaceConfigOptions): Promise<void> {
  if (!absoluteExecutable(options.toolboxExecutable)) throw new Error('CODEX_WORKSPACE_EXECUTABLE_INVALID')
  const path = join(options.codexHome, 'config.toml')
  const lockPath = join(dirname(path), 'laixin-config.lock')
  await managedLock(options.file, lockPath, async () => {
    const current = await options.file.read(path)
    if (current !== undefined) parseCodexTomlDocument(current)
    const base = removeManagedBlock(current ?? '')
    const block = renderManagedBlock(options.toolboxExecutable)
    const candidate = joinBlock(base, block)
    parseCodexTomlDocument(candidate)
    if (candidate === current) return
    await replaceConfigurationTransaction(options.file, [
      { path, before: current, after: candidate, validate: value => { if (value !== undefined) parseCodexTomlDocument(value) } }
    ], { backupAction: 'workspace' })
  })
}

function managedLock<T>(file: ManagedTextFile, path: string, task: () => Promise<T>): Promise<T> {
  return file.withConfigWriteLock === undefined ? withConfigWriteLock(path, task) : file.withConfigWriteLock(path, task)
}

function renderManagedBlock(executable: string): string {
  const command = tomlString(executable)
  const tables = apiSources.map(id => {
    const source = codexWorkspaceSources[id]
    const endpoint = modelProviders[id].endpoints.codex
    const baseUrl = endpoint.replace(/\/responses$/, '')
    return `# Source: ${id}\n[model_providers.${source.provider}]\nname = "${tomlString(source.title.replace(' · 新工作', ''))}"\nbase_url = "${tomlString(baseUrl)}"\nwire_api = "responses"\n\n[model_providers.${source.provider}.auth]\ncommand = "${command}"\nargs = ["--laixin-codex-provider-key", "${id}"]\nrefresh_interval_ms = 0\ntimeout_ms = 5000`
  })
  return `${managedBegin}\n${tables.join('\n\n')}\n${managedEnd}\n`
}

function removeManagedBlock(contents: string): string {
  const lines = contents.split('\n')
  const markers = lines.flatMap((line, index) => {
    const trimmed = line.trim()
    return trimmed === managedBegin || trimmed === managedEnd ? [index] : []
  })
  if (markers.length === 0) return contents
  if (markers.length !== 2 || lines[markers[0]].trim() !== managedBegin || lines[markers[1]].trim() !== managedEnd || markers[0] >= markers[1]) {
    throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
  }
  assertManagedBlock(lines.slice(markers[0] + 1, markers[1]))
  return [...lines.slice(0, markers[0]), ...lines.slice(markers[1] + 1)].join('\n').replace(/\n+$/g, '')
}

function assertManagedBlock(lines: readonly string[]): void {
  const expected = new Map<string, ReadonlySet<string>>()
  for (const id of apiSources) {
    const provider = codexWorkspaceSources[id].provider
    expected.set(`model_providers.${provider}`, new Set(['name', 'base_url', 'wire_api']))
    expected.set(`model_providers.${provider}.auth`, new Set(['command', 'args', 'refresh_interval_ms', 'timeout_ms']))
  }
  const seen = new Map<string, Set<string>>()
  let table: string | undefined
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('# Source: ')) continue
    const header = /^\[([^\]]+)\]$/.exec(line)
    if (header !== null) {
      table = header[1]
      if (!expected.has(table) || seen.has(table)) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
      seen.set(table, new Set())
      continue
    }
    const assignment = /^([a-z_]+)\s*=\s*.+$/.exec(line)
    if (assignment === null || table === undefined || !expected.get(table)?.has(assignment[1])) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
    const keys = seen.get(table)!
    if (keys.has(assignment[1])) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
    keys.add(assignment[1])
  }
  if (seen.size !== expected.size) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
  for (const [tableName, keys] of expected) {
    const actual = seen.get(tableName)
    if (actual === undefined || actual.size !== keys.size || [...keys].some(key => !actual.has(key))) throw new Error('AI_ACCESS_CONFIG_UNMANAGED')
  }
}

function joinBlock(base: string, block: string): string {
  const trimmed = base.replace(/\n+$/g, '')
  return trimmed === '' ? block : `${trimmed}\n\n${block}`
}

function absoluteExecutable(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

function tomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
