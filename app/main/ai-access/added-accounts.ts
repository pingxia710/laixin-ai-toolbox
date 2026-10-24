import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { app } from 'electron'

export type OfficialAccountShell = 'codex' | 'claude'

/**
 * 官方套餐「已添加账号」登记表（userData 下的一个小 JSON）。
 * 判据（创始人定）：没登录就不该扫本机账号——身份与用量读取只对在案账号进行，
 * 账号在案的唯一途径是走工具箱的官方登录仪式。每次都从盘上重读，
 * 登记方（登录完成钩子）与读取方（用量/身份桥）不共享过期缓存。
 */
export class AddedOfficialAccounts {
  constructor(private readonly file: string) {}

  // Phase 1 ⑤(登录竞态丢登记):读改写必须过这根串行闸——codex/claude 两个登录钩子并发
  // mark 时,基线两边从同一份旧账本起笔、后 rename 的把先 rename 的键整个盖掉。
  // 闸上不 await 别人的失败:前一笔写炸了,后一笔照常落(链上吞掉,⛔ 变成死锁闸)。
  private writeChain: Promise<unknown> = Promise.resolve()

  async key(shell: OfficialAccountShell): Promise<string | null> {
    const raw = await readFile(this.file, 'utf8').catch(() => undefined)
    if (raw === undefined) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      const value = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)[shell]
        : undefined
      return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
    } catch { return null }
  }

  async mark(shell: OfficialAccountShell, accountKey: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(accountKey)) throw new Error('OFFICIAL_ACCOUNT_KEY_INVALID')
    await this.write(shell, accountKey)
  }

  async clear(shell: OfficialAccountShell): Promise<void> {
    await this.write(shell, null)
  }

  private write(shell: OfficialAccountShell, accountKey: string | null): Promise<void> {
    const task = this.writeChain.then(() => this.writeNow(shell, accountKey))
    this.writeChain = task.then(() => undefined, () => undefined)
    return task
  }

  private async writeNow(shell: OfficialAccountShell, accountKey: string | null): Promise<void> {
    const raw = await readFile(this.file, 'utf8').catch(() => undefined)
    let parsed: Record<string, unknown> = {}
    if (raw !== undefined) {
      try {
        const value: unknown = JSON.parse(raw)
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
      } catch { /* 坏文件就地重建 */ }
    }
    if (accountKey === null) delete parsed[shell]
    else parsed[shell] = accountKey
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    // store.ts 规范:随机 tmp 独占创建(wx)+0600,失败就地清——固定 pid tmp 在同进程并发下
    // 互相踩、0644 把账号指纹摊给同机其他用户。
    const tmp = join(dirname(this.file), `official-accounts-${randomUUID()}.tmp`)
    try {
      await writeFile(tmp, JSON.stringify(parsed, null, 2), { flag: 'wx', mode: 0o600 })
      await rename(tmp, this.file)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

let shared: AddedOfficialAccounts | undefined

/** 进程内共用一份（读盘不缓存，多实例也一致）；测试里直接 new 一个临时目录的实例。 */
export function sharedAddedOfficialAccounts(): AddedOfficialAccounts {
  if (!shared) shared = new AddedOfficialAccounts(join(app.getPath('userData'), 'official-accounts.json'))
  return shared
}
