// 0.4.10 包一 · 第 3 条:安装超时只发 SIGTERM,子进程不理会就整体卡死。
// 两种真实形态都会中招:①官方安装脚本自己装了 SIGTERM handler;
// ②`bash -lc 'curl … | bash'` 的孙进程持着同一根 stdout 管道——父进程死了 'close' 也不来,
// 任务永远停在 running,客户界面上就是「一直在装」,而且下一次 start() 会把别的壳的旧任务原样返回。
// 这里起真进程验证:超时后进程组里一个都不剩、任务落到 failed。
import { describe, expect, it } from 'vitest'
import { execFileSync, spawn as realSpawn } from 'node:child_process'
import { defaultRecipes, type Recipes } from '../../app/main/recipes/recipes'
import { ShellInventory } from '../../app/main/shells/inventory'
import { ShellInstaller } from '../../app/main/shells/installer'

const inventory = () => new ShellInventory({ platform: 'darwin', home: '/Users/t', env: { PATH: '/usr/bin:/bin' }, recipes: () => defaultRecipes,
  exec: async () => '', exists: async () => false, fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch })

/** 把 codex 的安装命令换成指定命令,好让执行器去跑一个我们能观察的真进程。 */
function recipesRunning(command: readonly string[]): Recipes {
  return { ...defaultRecipes, shells: { ...defaultRecipes.shells,
    codex: { ...defaultRecipes.shells.codex, install: { darwin: [...command], win32: [...command] } } } }
}

/** 等任务离开 running,最多等 limit 毫秒——⛔ 无限等,卡死时要能红出来。 */
async function settled(installer: ShellInstaller, limit = 8_000): Promise<void> {
  const deadline = Date.now() + limit
  while (installer.status().phase === 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
/** 进程组里还剩几个:pgrep 无匹配时退出码 1。 */
function groupMembers(pgid: number): string[] {
  try { return execFileSync('pgrep', ['-g', String(pgid)], { encoding: 'utf8' }).split('\n').filter(Boolean) }
  catch { return [] }
}

/** 真 spawn 的透明包装:options(含 detached)原样交给 node,只额外记下 pid 供断言。 */
function watchedSpawn() {
  const pids: number[] = []
  const spawnImpl = ((file: string, args: string[], options: Record<string, unknown>) => {
    const child = realSpawn(file, args, options as never)
    if (child.pid) pids.push(child.pid)
    return child
  }) as unknown as typeof realSpawn
  return { spawnImpl, pids }
}

async function firstPid(pids: number[]): Promise<number> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (pids.length) return pids[0]
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('子进程没起来')
}

describe('第 3 条 · 安装超时必须把整棵进程树杀干净', () => {
  it('子进程无视 SIGTERM:超时后被 SIGKILL 收掉,任务落 failed 而不是永远 running', async () => {
    const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    const { spawnImpl, pids } = watchedSpawn()
    const installer = new ShellInstaller({ platform: 'darwin', recipes: () => recipesRunning([process.execPath, '-e', script]),
      inventory: inventory(), proxyUrl: () => undefined, spawn: spawnImpl, timeoutMs: 400, killGraceMs: 400 })
    installer.start('codex')
    const pid = await firstPid(pids)
    await settled(installer)
    expect(installer.status().phase).toBe('failed')
    await new Promise((r) => setTimeout(r, 300))
    expect(alive(pid)).toBe(false)
  }, 15_000)

  it('孙进程持着管道:整个进程组一起收掉,⛔ 留下 sleep/cat 在后台', async () => {
    const { spawnImpl, pids } = watchedSpawn()
    const installer = new ShellInstaller({ platform: 'darwin', recipes: () => recipesRunning(['bash', '-c', 'sleep 30 | cat']),
      inventory: inventory(), proxyUrl: () => undefined, spawn: spawnImpl, timeoutMs: 400, killGraceMs: 400 })
    installer.start('codex')
    const pid = await firstPid(pids)
    await settled(installer)
    expect(installer.status().phase).toBe('failed')
    await new Promise((r) => setTimeout(r, 300))
    expect(alive(pid)).toBe(false)
    expect(groupMembers(pid)).toEqual([])
  }, 15_000)

  it('卡住的任务超过阈值后 start() 可以重置,⛔ 把别的壳的旧任务原样返回', async () => {
    const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    const { spawnImpl, pids } = watchedSpawn()
    const installer = new ShellInstaller({ platform: 'darwin', recipes: () => recipesRunning([process.execPath, '-e', script]),
      inventory: inventory(), proxyUrl: () => undefined, spawn: spawnImpl, timeoutMs: 60_000, killGraceMs: 400, stallMs: 300 })
    installer.start('codex')
    const pid = await firstPid(pids)
    // 阈值内:仍然是同一个任务,不给抢
    expect(installer.start('claude-code').shell).toBe('codex')
    await new Promise((r) => setTimeout(r, 400))
    // 过了阈值:新任务顶掉旧的,界面上问的是哪个壳就答哪个壳
    expect(installer.start('claude-code').shell).toBe('claude-code')
    try { process.kill(-pid, 'SIGKILL') } catch { /* 用例自己收尾,⛔ 把孤儿留给后面的用例。 */ }
  }, 15_000)
})
