import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acknowledgeUpdate } from '../../app/main/desktop/updater'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function tempRoot(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const asar = 'new-version'
const makeApp = async (path: string, asarContent: string): Promise<void> => {
  await mkdir(join(path, 'Contents/Resources'), { recursive: true })
  await writeFile(join(path, 'Contents/Resources/app.asar'), asarContent)
}

describe('更新磁盘卫生', () => {
  it('更新成功确认后只保留最近一份 previous-*.app 备份', async () => {
    const directory = await tempRoot('toolbox-helper-prune-')
    const target = join(directory, 'installed.app')
    const staged = join(directory, 'staged.app')
    await makeApp(target, 'old-version')
    await makeApp(staged, asar)
    // 制造 3 份历史备份 + 当前将保留的这 1 份。
    for (const stamp of [1789154000000, 1789154100000, 1789154200000]) await makeApp(join(directory, `previous-${stamp}.app`), 'ancient')
    const installer = join(directory, 'asset.zip')
    await writeFile(installer, 'asset')
    const exited = spawn(process.execPath, ['-e', 'process.exit(0)'])
    await new Promise((resolve) => exited.once('close', resolve))
    const job = { parentPid: exited.pid, platform: 'mac', target, staged, installer, executable: join(target, 'Contents/MacOS/Toolbox'),
      userData: directory, version: '0.4.1-unified.13', asarSha256: createHash('sha256').update(asar).digest('hex'),
      assetSha256: createHash('sha256').update('asset').digest('hex'), assetSize: 5,
      result: join(directory, 'result.json'), ready: join(directory, 'ready'), acknowledgement: join(directory, 'ack.json') }
    type HelperCommand = (command: string, args: string[]) => Promise<{ stdout: string }>
    const commands: HelperCommand & { mock?: unknown } = vi.fn(async (command: string, args: string[]) => {
      if (command === '/usr/bin/ditto') await cp(args[0], args[1], { recursive: true })
      if (command === '/usr/bin/open') await writeFile(job.acknowledgement, JSON.stringify({ version: job.version }))
      return { stdout: '' }
    }) as HelperCommand & { mock?: unknown }
    const helper = createRequire(import.meta.url)('../../resources/update-helper.cjs') as { run(job: object, commands: (command: string, args: string[]) => Promise<{ stdout: string }>): Promise<void> }
    await helper.run(job, commands)
    expect(JSON.parse(await readFile(job.result, 'utf8'))).toMatchObject({ state: 'complete' })
    const remaining = (await readdir(directory)).filter((name) => /^previous-\d+\.app$/.test(name)).sort()
    expect(remaining).toHaveLength(1)
    expect(Number(remaining[0].match(/\d+/)![0])).toBeGreaterThan(1789154200000)
  })

  it('新版启动确认后清掉旧 download-* 工作目录,只留最近一份备份', async () => {
    const directory = await tempRoot('toolbox-ack-clean-')
    await writeFile(join(directory, 'pending.json'), JSON.stringify({ version: '0.4.7-fix.3' }))
    for (const stamp of [1789154000000, 1789154100000]) await makeApp(join(directory, `previous-${stamp}.app`), 'ancient')
    await makeApp(join(directory, 'previous-1789154200000.app'), 'previous')
    for (const name of ['download-AAA', 'download-BBB']) {
      await mkdir(join(directory, name), { recursive: true })
      await writeFile(join(directory, name, 'result.json'), '{}')
    }
    await acknowledgeUpdate(directory, '0.4.7-fix.3')
    const entries = await readdir(directory)
    expect(entries.filter((name) => /^previous-\d+\.app$/.test(name))).toEqual(['previous-1789154200000.app'])
    expect(entries.filter((name) => name.startsWith('download-'))).toEqual([])
    expect(JSON.parse(await readFile(join(directory, 'acknowledgement.json'), 'utf8'))).toMatchObject({ version: '0.4.7-fix.3' })
  })

  it('没有待确认更新时启动不清任何东西', async () => {
    const directory = await tempRoot('toolbox-ack-noop-')
    await makeApp(join(directory, 'previous-1000.app'), 'ancient')
    await mkdir(join(directory, 'download-AAA'), { recursive: true })
    await acknowledgeUpdate(directory, '0.4.7-fix.3')
    const entries = await readdir(directory)
    expect(entries).toContain('previous-1000.app')
    expect(entries).toContain('download-AAA')
    expect(entries).not.toContain('acknowledgement.json')
  })
})
