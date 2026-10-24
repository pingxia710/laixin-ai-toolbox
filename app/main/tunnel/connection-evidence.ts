import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// 只读取工具箱自己的复验时间文件，不读取 SSH 或 Hermes 配置。
export async function hasVerifiedConnection(dataDir: string): Promise<boolean> {
  try {
    const verified = JSON.parse(await readFile(join(dataDir, 'connection-verified.json'), 'utf8')) as { verifiedAt?: number }
    if (!Number.isFinite(verified.verifiedAt)) throw new Error('CONNECTION_EVIDENCE_INVALID')
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
