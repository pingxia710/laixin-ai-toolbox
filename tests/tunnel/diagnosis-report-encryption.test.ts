import { afterEach, expect, it, vi } from 'vitest'
import type * as Crypto from 'node:crypto'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { DiagnosisReporter, type DiagnosisPayload } from '../../app/main/tunnel/diagnosis-reporter'
import type { EncryptedQueueCodec } from '../../app/main/tunnel/diagnostic-event-queue'
import { makeTempDir, removeTempDir } from './helpers'

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>()
  return { ...actual, randomBytes: ((size: number) => size === 4
    ? Buffer.from('deadbeef', 'hex') : actual.randomBytes(size)) as typeof actual.randomBytes }
})

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(removeTempDir))

function codec(): EncryptedQueueCodec {
  const key = Buffer.alloc(32, 9)
  return {
    encrypt(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(plain), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decrypt(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
}

it('旧六字段离线队列也使用加密文件，持久化前去掉原始授权 ID，补传合同仍是六字段', async () => {
  const directory = makeTempDir('laixin-n53-six-field-')
  directories.push(directory)
  const queuePath = join(directory, 'diagnosis-pending.enc')
  const queueCodec = codec()
  const first = new DiagnosisReporter({
    send: async () => { throw new Error('OFFLINE') },
    enabled: () => true,
    platform: 'macos',
    version: () => '0.5.20-test',
    now: () => 1_000_000,
    queuePath,
    queueCodec
  })
  first.report({
    code: 'TUNNEL_COMPONENT_MISSING',
    stage: 'connect-start',
    authorizationId: `lx-${'a'.repeat(32)}`
  })
  await vi.waitFor(() => expect(existsSync(queuePath)).toBe(true))

  const bytes = readFileSync(queuePath)
  expect(bytes.toString('utf8')).not.toContain('TUNNEL_COMPONENT_MISSING')
  expect(bytes.toString('utf8')).not.toContain(`lx-${'a'.repeat(32)}`)
  const stored = JSON.parse(queueCodec.decrypt(bytes)) as DiagnosisPayload[]
  expect(stored[0].authorizationId).toBe('')

  const sent: DiagnosisPayload[] = []
  const reopened = new DiagnosisReporter({
    send: async (payload) => { sent.push(payload) },
    enabled: () => true,
    platform: 'macos',
    version: () => '0.5.20-test',
    now: () => 1_000_000,
    queuePath,
    queueCodec
  })
  await reopened.flushPending()
  expect(sent).toHaveLength(1)
  expect(Object.keys(sent[0]).sort()).toEqual(['authorizationId', 'clientVersion', 'code', 'platform', 'stage', 'timestamp'])
  expect(sent[0].authorizationId).toBe('')
})

it('升级时把旧版明文六字段队列单向迁移为密文且清掉原始授权 ID', async () => {
  const directory = makeTempDir('laixin-n53-six-field-migration-')
  directories.push(directory)
  const queuePath = join(directory, 'diagnosis-pending.json')
  const queueCodec = codec()
  const rawAuthorizationId = `lx-${'b'.repeat(32)}`
  writeFileSync(queuePath, JSON.stringify([{
    code: 'TUNNEL_COMPONENT_MISSING',
    stage: 'connect-start',
    platform: 'macos',
    clientVersion: '0.5.19',
    authorizationId: rawAuthorizationId,
    timestamp: 999_000
  }]), { mode: 0o600 })

  const sent: DiagnosisPayload[] = []
  const reporter = new DiagnosisReporter({
    send: async (payload) => { sent.push(payload) },
    enabled: () => true,
    platform: 'macos',
    version: () => '0.5.20-test',
    now: () => 1_000_000,
    queuePath,
    queueCodec
  })
  await reporter.flushPending()

  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ code: 'TUNNEL_COMPONENT_MISSING', authorizationId: '' })
  const encrypted = readFileSync(queuePath)
  expect(encrypted.toString('utf8')).not.toContain(rawAuthorizationId)
  expect(JSON.parse(queueCodec.decrypt(encrypted))).toEqual([])
})

it('客户关闭回传时仍迁移旧明文，但不发送', async () => {
  const directory = makeTempDir('laixin-n53-six-field-disabled-')
  directories.push(directory)
  const queuePath = join(directory, 'diagnosis-pending.json')
  const queueCodec = codec()
  const rawAuthorizationId = `lx-${'c'.repeat(32)}`
  writeFileSync(queuePath, JSON.stringify([{
    code: 'TUNNEL_COMPONENT_MISSING', stage: 'connect-start', platform: 'macos', clientVersion: '0.5.19',
    authorizationId: rawAuthorizationId, timestamp: 999_000
  }]), { mode: 0o644 })
  const send = vi.fn(async () => undefined)
  const reporter = new DiagnosisReporter({
    send, enabled: () => false, platform: 'macos', version: () => '0.5.20-test', now: () => 1_000_000,
    queuePath, queueCodec
  })

  await reporter.flushPending()
  expect(send).not.toHaveBeenCalled()
  const encrypted = readFileSync(queuePath)
  expect(encrypted.toString('utf8')).not.toContain(rawAuthorizationId)
  expect(JSON.parse(queueCodec.decrypt(encrypted))).toEqual([expect.objectContaining({ authorizationId: '' })])
})

it('系统加密不可用时删掉旧明文授权队列', async () => {
  const directory = makeTempDir('laixin-n53-six-field-no-safe-storage-')
  directories.push(directory)
  const queuePath = join(directory, 'diagnosis-pending.json')
  writeFileSync(queuePath, JSON.stringify([{
    code: 'TUNNEL_COMPONENT_MISSING', stage: 'connect-start', platform: 'macos', clientVersion: '0.5.19',
    authorizationId: `lx-${'d'.repeat(32)}`, timestamp: 999_000
  }]), { mode: 0o600 })
  const unavailable: EncryptedQueueCodec = {
    encrypt() { throw new Error('UNAVAILABLE') },
    decrypt() { throw new Error('UNAVAILABLE') }
  }
  const reporter = new DiagnosisReporter({
    send: async () => undefined, enabled: () => true, platform: 'macos', version: () => '0.5.20-test',
    now: () => 1_000_000, queuePath, queueCodec: unavailable
  })

  await reporter.flushPending()
  expect(existsSync(queuePath)).toBe(false)
})

it('关闭回传时超限的旧明文专用队列也会清理', async () => {
  const directory = makeTempDir('laixin-n53-six-field-oversized-')
  directories.push(directory)
  const queuePath = join(directory, 'diagnosis-pending.json')
  writeFileSync(queuePath, `[${' '.repeat(300 * 1024)}]`, { mode: 0o600 })
  const reporter = new DiagnosisReporter({
    send: async () => undefined, enabled: () => false, platform: 'macos', version: () => '0.5.20-test',
    now: () => 1_000_000, queuePath, queueCodec: codec()
  })

  await reporter.flushPending()
  expect(existsSync(queuePath)).toBe(false)
})

it('启动迁移在回传关闭时仍清理严格命名的崩溃遗留明文临时文件', async () => {
  const directory = makeTempDir('laixin-n53-six-field-temp-disabled-')
  directories.push(directory)
  const queuePath = join(directory, 'diagnosis-pending.json')
  const legacyTemporary = `${queuePath}.tmp-deadbeef`
  const unrelated = `${queuePath}.tmp-deadbee`
  const nested = join(directory, 'nested')
  const nestedSameName = join(nested, 'diagnosis-pending.json.tmp-deadbeef')
  mkdirSync(nested)
  writeFileSync(legacyTemporary, '[{"authorizationId":"plaintext"}]', { mode: 0o600 })
  writeFileSync(unrelated, 'keep', { mode: 0o600 })
  writeFileSync(nestedSameName, 'nested-keep', { mode: 0o600 })
  const reporter = new DiagnosisReporter({
    send: async () => undefined, enabled: () => false, platform: 'macos', version: () => '0.5.20-test',
    now: () => 1_000_000, queuePath, queueCodec: codec()
  })

  await reporter.flushPending()
  expect(existsSync(legacyTemporary)).toBe(false)
  expect(readFileSync(unrelated, 'utf8')).toBe('keep')
  expect(readFileSync(nestedSameName, 'utf8')).toBe('nested-keep')
})

it('启动迁移用 lstat 处理严格命名符号链接，只删链接而不跟随或删目标', async () => {
  const directory = makeTempDir('laixin-n53-six-field-temp-symlink-')
  directories.push(directory)
  const queuePath = join(directory, 'diagnosis-pending.json')
  const target = join(directory, 'customer-owned.txt')
  const legacyTemporary = `${queuePath}.tmp-cafebabe`
  writeFileSync(target, 'customer-owned', { mode: 0o600 })
  symlinkSync(target, legacyTemporary)
  const reporter = new DiagnosisReporter({
    send: async () => undefined, enabled: () => false, platform: 'macos', version: () => '0.5.20-test',
    now: () => 1_000_000, queuePath, queueCodec: codec()
  })

  await reporter.flushPending()
  expect(existsSync(legacyTemporary)).toBe(false)
  expect(readFileSync(target, 'utf8')).toBe('customer-owned')
})

it('系统加密不可用时仍清理超限的严格命名旧明文临时文件', async () => {
  const directory = makeTempDir('laixin-n53-six-field-temp-unavailable-')
  directories.push(directory)
  const queuePath = join(directory, 'diagnosis-pending.json')
  const legacyTemporary = `${queuePath}.tmp-0123abcd`
  writeFileSync(legacyTemporary, `[${' '.repeat(300 * 1024)}]`, { mode: 0o600 })
  const unavailable: EncryptedQueueCodec = {
    encrypt() { throw new Error('UNAVAILABLE') },
    decrypt() { throw new Error('UNAVAILABLE') }
  }
  const reporter = new DiagnosisReporter({
    send: async () => undefined, enabled: () => true, platform: 'macos', version: () => '0.5.20-test',
    now: () => 1_000_000, queuePath, queueCodec: unavailable
  })

  await reporter.flushPending()
  expect(existsSync(legacyTemporary)).toBe(false)
})

it('旧队列原子 rename 失败时清理本轮自身临时文件', async () => {
  const directory = makeTempDir('laixin-n53-six-field-rename-')
  directories.push(directory)
  const queuePath = join(directory, 'diagnosis-pending.json')
  mkdirSync(queuePath)
  const baseCodec = codec()
  const encrypt = vi.fn(baseCodec.encrypt)
  const reporter = new DiagnosisReporter({
    send: async () => { throw new Error('OFFLINE') },
    enabled: () => true,
    platform: 'macos',
    version: () => '0.5.20-test',
    now: () => 1_000_000,
    queuePath,
    queueCodec: { encrypt, decrypt: baseCodec.decrypt }
  })

  reporter.report({ code: 'TUNNEL_COMPONENT_MISSING', stage: 'connect-start' })
  await vi.waitFor(() => expect(encrypt).toHaveBeenCalled())
  expect(lstatSync(queuePath).isDirectory()).toBe(true)
  expect(readdirSync(directory).filter((name) => name.startsWith('diagnosis-pending.json.tmp-'))).toEqual([])
})

it('旧队列 wx 随机名碰撞时不删除非本轮创建的既存临时文件', async () => {
  const directory = makeTempDir('laixin-n53-six-field-collision-')
  directories.push(directory)
  const queuePath = join(directory, 'diagnosis-pending.enc')
  const existingTemporary = `${queuePath}.tmp-deadbeef`
  writeFileSync(existingTemporary, 'existing-owner', { mode: 0o600 })
  const baseCodec = codec()
  const encrypt = vi.fn(baseCodec.encrypt)
  const reporter = new DiagnosisReporter({
    send: async () => { throw new Error('OFFLINE') },
    enabled: () => true,
    platform: 'macos',
    version: () => '0.5.20-test',
    now: () => 1_000_000,
    queuePath,
    queueCodec: { encrypt, decrypt: baseCodec.decrypt }
  })

  reporter.report({ code: 'TUNNEL_COMPONENT_MISSING', stage: 'connect-start' })
  await vi.waitFor(() => expect(encrypt).toHaveBeenCalled())
  expect(readFileSync(existingTemporary, 'utf8')).toBe('existing-owner')
})
