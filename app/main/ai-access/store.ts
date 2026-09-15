import { safeStorage } from 'electron'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { validAiAccessState, type AiAccessState, type AiAccessStateStore } from './service'

const emptyState = (): AiAccessState => ({ version: 1, selected: {} })

/** Customer connection data stays encrypted on this computer and is never sent to the service backend. */
export function createAiAccessStore(root: string): AiAccessStateStore {
  const path = join(root, 'ai-access.enc')
  // 解密/校验失败 ≠ 存储不可用:坏文件改名 *.corrupt-<时间戳> 留证,按空状态返回。
  // DPAPI 凭据丢失、系统重装、换用户是常见来源,⛔ 把用户永久锁死在报错里。
  let corruptionNote: string | undefined
  const quarantine = async (): Promise<AiAccessState> => {
    corruptionNote = '保存的 Key 已失效，请重新添加。'
    try { await rename(path, `${path}.corrupt-${Date.now()}`) } catch { /* 改名失败也按空状态返回,坏文件留在原处 */ }
    return emptyState()
  }
  return {
    consumeCorruptionNote() {
      const note = corruptionNote
      corruptionNote = undefined
      return note
    },
    async read() {
      let bytes: Buffer
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 || (process.platform !== 'win32' && (info.mode & 0o077))) {
          throw new Error('AI_ACCESS_STORAGE_INVALID')
        }
        bytes = await readFile(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
        throw new Error('AI_ACCESS_STORAGE_INVALID', { cause: error })
      }
      assertEncryptionAvailable()
      let state: unknown
      try {
        state = JSON.parse(safeStorage.decryptString(bytes))
      } catch {
        return await quarantine()
      }
      if (!validAiAccessState(state)) return await quarantine()
      return state
    },
    async write(state) {
      if (!validAiAccessState(state)) throw new Error('AI_ACCESS_STORAGE_INVALID')
      assertEncryptionAvailable()
      await mkdir(root, { recursive: true, mode: 0o700 })
      let temporary: string | undefined
      try {
        const info = await lstat(root)
        if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) {
          throw new Error('AI_ACCESS_STORAGE_INVALID')
        }
        temporary = join(root, `ai-access-${randomUUID()}.tmp`)
        await writeFile(temporary, safeStorage.encryptString(JSON.stringify(state)), { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
        temporary = undefined
      } catch {
        if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
        throw new Error('AI_ACCESS_STORAGE_INVALID')
      }
    }
  }
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('AI_ACCESS_STORAGE_UNAVAILABLE')
  }
}
