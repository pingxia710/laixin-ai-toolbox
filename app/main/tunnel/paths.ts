import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

// 数据目录解析:测试经 TOOLBOX_TUNNEL_DATA_DIR 注入;生产 = <userData>/tunnel。
export function resolveTunnelDataDir(env: NodeJS.ProcessEnv, userDataPath?: string): string {
  const override = env.TOOLBOX_TUNNEL_DATA_DIR
  if (typeof override === 'string' && override !== '') {
    return override
  }
  if (userDataPath !== undefined) {
    return join(userDataPath, 'tunnel')
  }
  throw new Error('TUNNEL_DATA_DIR_UNSET')
}

export function writeFileAtomic(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${randomBytes(4).toString('hex')}`
  writeFileSync(temporary, content, { mode })
  renameSync(temporary, path)
}

// 批次 id = 时刻 + 随机(定稿第 4 轮 2)。
export function generateBatchId(now: () => number = Date.now): string {
  const stamp = new Date(now())
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\..+$/, '')
  return `${stamp}-${randomBytes(4).toString('hex')}`
}

export const layout = {
  imports: (dataDir: string) => join(dataDir, 'imports'),
  staging: (dataDir: string) => join(dataDir, 'staging'),
  batchDir: (dataDir: string, batchId: string) => join(dataDir, 'imports', batchId),
  stagingDir: (dataDir: string, batchId: string) => join(dataDir, 'staging', batchId),
  currentPointer: (dataDir: string) => join(dataDir, 'current'),
  pendingPointer: (dataDir: string) => join(dataDir, 'pending'),
  rollbackPointer: (dataDir: string) => join(dataDir, 'rollback'),
  intent: (dataDir: string) => join(dataDir, 'intent.json'),
  state: (dataDir: string) => join(dataDir, 'state.json'),
  ledger: (dataDir: string) => join(dataDir, 'ledger.json')
}
