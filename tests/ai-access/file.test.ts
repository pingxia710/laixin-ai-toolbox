import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { symlinkLocationOf } from '../../app/main/ai-access/configuration-target'
import { createManagedTextFile } from '../../app/main/ai-access/file'

let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = '' })

describe('壳配置文件写入', () => {
  it('新文件以原子替换写入、权限收紧，并且能删除工具箱拥有的文件', async () => {
    root = await mkdtemp(join(tmpdir(), 'toolbox-ai-access-file-'))
    const path = join(root, 'profile', 'config.toml')
    const file = createManagedTextFile()
    await file.write(path, 'fixture\n')

    expect(await readFile(path, 'utf8')).toBe('fixture\n')
    await file.remove(path)
    await expect(file.read(path)).resolves.toBeUndefined()
  })

  it('拒绝将配置写进符号链接目标', async () => {
    root = await mkdtemp(join(tmpdir(), 'toolbox-ai-access-link-'))
    const real = join(root, 'real')
    const linked = join(root, 'linked')
    await mkdir(real)
    await symlink(real, linked)
    await expect(createManagedTextFile().write(join(linked, 'config.toml'), 'fixture\n')).rejects.toThrow('AI_ACCESS_CONFIG_FILE_INVALID')
  })

  it('读到的配置是软链时，错误仍是 INVALID 但带链接位置和真身（第 3 轮返修）', async () => {
    root = await mkdtemp(join(tmpdir(), 'toolbox-ai-access-symlink-'))
    const real = join(root, 'dotfiles', 'settings.json')
    const linked = join(root, 'settings.json')
    await mkdir(join(real, '..'), { recursive: true })
    await writeFile(real, '{}\n')
    await symlink(real, linked)
    const failure = await createManagedTextFile().read(linked).then(() => undefined, (value: unknown) => value)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('AI_ACCESS_CONFIG_FILE_INVALID')
    // mac 的 /var 本身是 /private/var 的软链，真身要用 realpath 对。
    expect(symlinkLocationOf(failure)).toEqual({ path: linked, target: await realpath(real) })
    // 普通文件不误标。
    expect(symlinkLocationOf(undefined)).toBeUndefined()
  })

  it('比较后的客户编辑会被 descriptor inode、版本和内容复核发现，旧文件不会被覆盖', async () => {
    root = await mkdtemp(join(tmpdir(), 'toolbox-ai-access-file-'))
    const path = join(root, 'profile', 'config.toml')
    const file = createManagedTextFile({ beforeAppend: async () => { await writeFile(path, 'customer-edit\n') } })
    await file.write(path, 'before\n')

    await expect(file.appendIfCurrent(path, 'before\n', '# toolbox inert block\n')).resolves.toBe('changed')
    await expect(readFile(path, 'utf8')).resolves.toBe('customer-edit\n')
  })

  it('成功路径只追加受控块，绝不 replace 客户已有字节', async () => {
    root = await mkdtemp(join(tmpdir(), 'toolbox-ai-access-file-'))
    const path = join(root, 'profile', 'config.toml')
    const file = createManagedTextFile()
    await file.write(path, 'customer-setting\n')

    await expect(file.appendIfCurrent(path, 'customer-setting\n', '# toolbox inert block\n')).resolves.toBe('appended')
    await expect(readFile(path, 'utf8')).resolves.toBe('customer-setting\n# toolbox inert block\n')
  })

  it('工具箱标记只能 O_EXCL 创建，竞争中绝不覆盖后来文件', async () => {
    root = await mkdtemp(join(tmpdir(), 'toolbox-ai-access-file-'))
    const path = join(root, 'private', 'marker.enabled')
    const file = createManagedTextFile()

    await expect(file.createIfMissing(path, 'owned-token\n')).resolves.toBe('created')
    await expect(readFile(path, 'utf8')).resolves.toBe('owned-token\n')
    await expect(file.createIfMissing(path, 'must-not-overwrite\n')).resolves.toBe('exists')
    await expect(readFile(path, 'utf8')).resolves.toBe('owned-token\n')
  })
})
