import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { modelProviderIds, normalizeProviderModel } from '../../shared/model-providers'
import { apiFailureMessages, type ApiFailure, type ApiShell, type ModelProviderId } from '../../shared/api-service-types'
import type { ModelMatrixEntry, ModelMatrixReport, ModelMatrixSkip, ModelMatrixState } from '../../shared/model-matrix-types'

const shells: readonly ApiShell[] = ['codex', 'claude', 'hermes']
const states: readonly ModelMatrixState[] = ['passed', 'failed', 'skipped']
const skips: readonly ModelMatrixSkip[] = ['key_missing', 'shell_missing', 'version_gate']

/** 矩阵结果里只有来源、软件、模型、结果、耗时与时间，**⛔ Key**。读写都按这张清单过一遍。 */
export function sanitizeMatrixReport(value: unknown): ModelMatrixReport | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at)) || !Array.isArray(raw.entries)) return undefined
  const entries = raw.entries.map(sanitizeMatrixEntry).filter((entry): entry is ModelMatrixEntry => entry !== undefined)
  return { at: raw.at, entries }
}

function sanitizeMatrixEntry(value: unknown): ModelMatrixEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  if (!modelProviderIds.includes(raw.provider as ModelProviderId) || !shells.includes(raw.shell as ApiShell)) return undefined
  // A matrix is historical evidence: preserve an old approved spelling (for example
  // deepseek-v4-flash), but never accept the broad state-storage regex as test evidence.
  if (typeof raw.model !== 'string' || normalizeProviderModel(raw.provider as ModelProviderId, raw.shell as ApiShell, raw.model) === undefined) return undefined
  if (!states.includes(raw.state as ModelMatrixState)) return undefined
  if (typeof raw.at !== 'string' || !Number.isFinite(Date.parse(raw.at))) return undefined
  const code = typeof raw.code === 'string' && Object.hasOwn(apiFailureMessages, raw.code) ? raw.code as ApiFailure : undefined
  const skipped = skips.includes(raw.skipped as ModelMatrixSkip) ? raw.skipped as ModelMatrixSkip : undefined
  const firstTextMs = typeof raw.firstTextMs === 'number' && Number.isSafeInteger(raw.firstTextMs) && raw.firstTextMs >= 0 ? raw.firstTextMs : undefined
  return {
    provider: raw.provider as ModelProviderId, shell: raw.shell as ApiShell, model: raw.model,
    state: raw.state as ModelMatrixState, at: raw.at,
    ...(code ? { code } : {}), ...(skipped ? { skipped } : {}), ...(firstTextMs === undefined ? {} : { firstTextMs })
  }
}

export interface ModelMatrixFiles {
  read(): Promise<string | undefined>
  write(contents: string): Promise<void>
}

/** 最近一次验证矩阵；供运维脚本与客服摘要读取。 */
export class ModelMatrixStore {
  constructor(private readonly files: ModelMatrixFiles) {}

  async save(report: ModelMatrixReport): Promise<void> {
    const safe = sanitizeMatrixReport(report)
    if (!safe) throw new Error('AI_ACCESS_MATRIX_REPORT_INVALID')
    try { await this.files.write(`${JSON.stringify(safe, null, 2)}\n`) } catch { throw new Error('AI_ACCESS_MATRIX_SAVE_FAILED') }
  }

  async read(): Promise<ModelMatrixReport | undefined> {
    let contents: string | undefined
    try { contents = await this.files.read() } catch { return undefined }
    if (contents === undefined) return undefined
    try { return sanitizeMatrixReport(JSON.parse(contents)) } catch { return undefined }
  }
}

/** 生产落盘：目录 0700、文件 0600，原子替换，不跟随符号链接。 */
export function createModelMatrixFiles(path: string): ModelMatrixFiles {
  return {
    async read() {
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return undefined
        return await readFile(path, 'utf8')
      } catch { return undefined }
    },
    async write(contents) {
      const parent = dirname(path)
      await mkdir(parent, { recursive: true, mode: 0o700 })
      const temporary = join(parent, `.model-matrix-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
    }
  }
}
