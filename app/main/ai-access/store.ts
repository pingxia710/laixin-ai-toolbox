import { safeStorage } from 'electron'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { configFaultCore, configWriteFaultNotice } from './config-write-fault'
import { validAiAccessState, type AiAccessState, type AiAccessStateStore } from './service'

const emptyState = (): AiAccessState => ({ version: 1, selected: {} })

/** 写失败分译(Phase 2 ⑤)的注入点:真实实现走 node:fs/promises,测试用它造 ENOSPC 等故障。 */
export interface AiAccessStoreDeps {
  readonly writeFile?: typeof writeFile
}

/** 底层 fs 故障 → 分译码:磁盘满 / 权限 / 其余(损坏类,维持原码)。 */
function writeFaultCode(code: string | undefined): string {
  if (code === 'ENOSPC') return 'AI_ACCESS_STORAGE_DISK_FULL'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'AI_ACCESS_STORAGE_PERMISSION_DENIED'
  return 'AI_ACCESS_STORAGE_INVALID'
}

/** Customer connection data stays encrypted on this computer and is never sent to the service backend. */
export function createAiAccessStore(root: string, deps: AiAccessStoreDeps = {}): AiAccessStateStore {
  const path = join(root, 'ai-access.enc')
  // 解密/校验失败 ≠ 存储不可用:坏文件改名 *.corrupt-<时间戳> 留证,按空状态返回。
  // DPAPI 凭据丢失、系统重装、换用户是常见来源,⛔ 把用户永久锁死在报错里。
  let corruptionNote: string | undefined
  // 写失败的一句话(磁盘满/权限/通用各一译,复用 config-write-fault 的翻译能力),status() 取走后清空。
  let writeFaultNote: string | undefined
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
    consumeWriteFaultNote() {
      const note = writeFaultNote
      writeFaultNote = undefined
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
        await (deps.writeFile ?? writeFile)(temporary, safeStorage.encryptString(JSON.stringify(state)), { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
        temporary = undefined
      } catch (error) {
        if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
        // 写失败分译:⛔ 把磁盘满(EACCES 亦然)折进「存储损坏」,客户照着修永远修不好。
        // 码分层给调用方判因;一句话给客户照做,随下一次 status() 上屏。
        if ((error as Error)?.message !== 'AI_ACCESS_STORAGE_INVALID') {
          const core = configFaultCore(error)
          const note = await configWriteFaultNotice(error).catch(() => undefined)
          if (core.code !== undefined || core.path !== undefined || note !== undefined) writeFaultNote = note
          throw new Error(writeFaultCode(core.code), { cause: error })
        }
        throw error
      }
    }
  }
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
    throw new Error('AI_ACCESS_STORAGE_UNAVAILABLE')
  }
}
