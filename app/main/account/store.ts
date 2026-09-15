import { safeStorage } from 'electron'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { AccountSession } from '../../account-types'
import { AccountClientError, validSession, type SessionStore } from './client'

export function createSessionStore(root: string): SessionStore {
  const path = join(root, 'session.enc')
  // 解密/校验失败 ≠ 存储不可用:坏文件改名 *.corrupt-<时间戳> 留证,按未登录返回。
  // DPAPI 凭据丢失、系统重装、换用户是常见来源,⛔ 把用户永久锁死在报错里。
  let corruptionNote: string | undefined
  const quarantine = async (): Promise<null> => {
    corruptionNote = '保存的登录已失效，请重新登录。'
    try { await rename(path, `${path}.corrupt-${Date.now()}`) } catch { /* 改名失败也按未登录返回,坏文件留在原处 */ }
    return null
  }
  const available = () => {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new AccountClientError('ACCOUNT_STORAGE_UNAVAILABLE')
  }
  return {
    consumeCorruptionNote() {
      const note = corruptionNote
      corruptionNote = undefined
      return note
    },
    async deviceId() {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const directory = await lstat(root)
      if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== 'win32' && (directory.mode & 0o077))) throw new AccountClientError('ACCOUNT_STORAGE_UNAVAILABLE')
      const file = join(root, 'device-id')
      try { await writeFile(file, `device_${randomBytes(16).toString('hex')}`, { flag: 'wx', mode: 0o600 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== 39) throw new AccountClientError('ACCOUNT_STORAGE_UNAVAILABLE')
      const id = await readFile(file, 'utf8')
      if (!/^device_[a-f0-9]{32}$/.test(id)) throw new AccountClientError('ACCOUNT_STORAGE_UNAVAILABLE')
      return id
    },
    async read() {
      let bytes: Buffer
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 || (process.platform !== 'win32' && (info.mode & 0o077))) throw new AccountClientError('ACCOUNT_STORAGE_UNAVAILABLE')
        bytes = await readFile(path)
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      available()
      let session: unknown
      try {
        session = JSON.parse(safeStorage.decryptString(bytes))
      } catch {
        return await quarantine()
      }
      if (!validSession(session)) return await quarantine()
      return session
    },
    async write(session: AccountSession | null) {
      if (!session) { await rm(path, { force: true }); return }
      available()
      await mkdir(root, { recursive: true, mode: 0o700 })
      const info = await lstat(root)
      if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new AccountClientError('ACCOUNT_STORAGE_UNAVAILABLE')
      const temporary = join(root, `session-${randomUUID()}.tmp`)
      await writeFile(temporary, safeStorage.encryptString(JSON.stringify(session)), { flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
    }
  }
}
