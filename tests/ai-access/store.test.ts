import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
