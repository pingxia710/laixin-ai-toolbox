import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAiAccessStore } from '../../app/main/ai-access/store'

vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'keychain',
  encryptString: (value: string) => Buffer.from(`encrypted:${Buffer.from(value).toString('base64url')}`),
  decryptString: (value: Buffer) => Buffer.from(value.toString().replace('encrypted:', ''), 'base64url').toString()
} }))

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })

describe('AI 接入加密存储', () => {
  it('DeepSeek Key 以客户电脑的加密存储落盘，重开仍可读取，明文不进入文件', async () => {
    root = mkdtempSync(join(tmpdir(), 'toolbox-ai-access-store-'))
    const key = 'sk-toolbox-fixture-key-1234567890'
    const store = createAiAccessStore(root)
    await store.write({ version: 1, deepseekKey: key, selected: { codex: 'deepseek' } })

    expect(readFileSync(join(root, 'ai-access.enc'), 'utf8')).not.toContain(key)
    expect(await createAiAccessStore(root).read()).toEqual({ version: 1, deepseekKey: key, selected: { codex: 'deepseek' } })
  })

  it('没有保存过接入信息时返回空状态，不把空值伪造成某个壳已选中', async () => {
    root = mkdtempSync(join(tmpdir(), 'toolbox-ai-access-empty-'))
    await expect(createAiAccessStore(root).read()).resolves.toEqual({ version: 1, selected: {} })
  })
})

it('接入文件解密/校验失败时自动隔离坏文件并按空状态返回,提示一次,坏文件改名留证', async () => {
  root = mkdtempSync(join(tmpdir(), 'toolbox-ai-access-corrupt-'))
  const store = createAiAccessStore(root)
  await store.write({ version: 1, deepseekKey: 'sk-toolbox-fixture-key-1234567890', selected: { codex: 'deepseek' } })
  const { writeFileSync, readdirSync } = await import('node:fs')
  writeFileSync(join(root, 'ai-access.enc'), Buffer.from([0x00, 0x7f, 0xfa, 0x11, 0x5c]))

  const fresh = createAiAccessStore(root)
  await expect(fresh.read()).resolves.toEqual({ version: 1, selected: {} })
  expect(readdirSync(root).some((name) => name.startsWith('ai-access.enc.corrupt-'))).toBe(true)
  expect(fresh.consumeCorruptionNote?.()).toBe('保存的 Key 已失效，请重新添加。')
  expect(fresh.consumeCorruptionNote?.()).toBeUndefined()
})

// Phase 2 ⑤:写失败分译——磁盘满/权限各是一个码加一句客户能照做的话,⛔ 全折进
// AI_ACCESS_STORAGE_INVALID 让磁盘满的客户对着「存储不可用」无所适从。翻译复用 config-write-fault。
it('写失败分译:磁盘满是磁盘满的码与话,只提示一次', async () => {
  root = mkdtempSync(join(tmpdir(), 'toolbox-ai-access-enospc-'))
  const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC', path: join(root, 'ai-access.enc') })
  const store = createAiAccessStore(root, { writeFile: async () => { throw enospc } })
  await expect(store.write({ version: 1, selected: {} })).rejects.toMatchObject({ message: 'AI_ACCESS_STORAGE_DISK_FULL' })
  const note = store.consumeWriteFaultNote?.()
  expect(note).toContain('磁盘满')
  expect(note).toContain('清理')
  expect(store.consumeWriteFaultNote?.()).toBeUndefined()
})

it('写失败分译:权限单独报权限,话里带客户能做的动作', async () => {
  root = mkdtempSync(join(tmpdir(), 'toolbox-ai-access-eacces-'))
  // 真实路径走不到「0o700 目录还 EACCES」;松权限目录在写入前的指纹闸就被拒(另一条受控路径)。
  // 这里用注入 seam 造 EACCES,分译映射本身才是被测对象。
  const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES', path: join(root, 'ai-access.enc') })
  const store = createAiAccessStore(root, { writeFile: async () => { throw eacces } })
  await expect(store.write({ version: 1, selected: {} })).rejects.toMatchObject({ message: 'AI_ACCESS_STORAGE_PERMISSION_DENIED' })
  expect(store.consumeWriteFaultNote?.()).toContain('权限')
})

it('写失败分译:目录过松被指纹闸拒仍是受控的 INVALID,⛔ 冒充分译码', async () => {
  if (process.platform === 'win32') return
  root = mkdtempSync(join(tmpdir(), 'toolbox-ai-access-loose-'))
  chmodSync(root, 0o755)
  const store = createAiAccessStore(root)
  await expect(store.write({ version: 1, selected: {} })).rejects.toMatchObject({ message: 'AI_ACCESS_STORAGE_INVALID' })
  expect(store.consumeWriteFaultNote?.()).toBeUndefined()
})
