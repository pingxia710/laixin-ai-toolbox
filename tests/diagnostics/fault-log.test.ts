import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFaultLogFiles, FaultLog, type FaultLogFiles } from '../../app/main/diagnostics/fault-log'
import { faultLine, sanitizeFaultRecord } from '../../app/shared/fault-log-types'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function memoryFiles(initial: Readonly<Record<string, string>> = {}) {
  const data = new Map(Object.entries(initial))
  const files: FaultLogFiles = {
    list: async () => [...data.keys()],
    read: async (name) => data.get(name),
    write: async (name, contents) => { data.set(name, contents) },
    append: async (name, line) => { data.set(name, (data.get(name) ?? '') + line) },
    remove: async (name) => { data.delete(name) }
  }
  return { files, data }
}
const day = (value: string) => Date.parse(`${value}T09:00:00.000Z`)

describe('故障经过按天留存', () => {
  it('记下时间、版本、软件、渠道、判类、处理动作与复验结果，客服一行看懂', async () => {
    const f = memoryFiles()
    let at = day('2026-09-12')
    const log = new FaultLog({ files: f.files, version: () => '0.4.9', now: () => at })
    await log.record({ shell: 'codex', provider: 'deepseek', code: 'key_rejected' })
    at += 120_000
    await log.record({ shell: 'codex', provider: 'deepseek', code: 'key_rejected', action: 'retest', outcome: 'still_failing' })
    at += 120_000
    await log.record({ network: 'AI_DIAG_TUNNEL_REQUIRED' })

    const records = await log.recent()
    expect(records).toHaveLength(3)
    expect(records[2]).toMatchObject({ version: '0.4.9', shell: 'codex', provider: 'deepseek', code: 'key_rejected' })
    expect(records[1]).toMatchObject({ action: 'retest', outcome: 'still_failing' })
    expect(records[0]).toMatchObject({ network: 'AI_DIAG_TUNNEL_REQUIRED' })
    const line = faultLine(records[1])
    expect(line).toContain('Codex')
    expect(line).toContain('试过「重新测试」')
    expect(line).toContain('仍有问题')
  })

  it('⛔ 写入 Key、令牌、提示词或回复正文：说明只收模板 id，自由文本整条丢掉', async () => {
    const f = memoryFiles()
    const log = new FaultLog({ files: f.files, version: () => '0.4.9', now: () => day('2026-09-12'), dedupeMs: 0 })
    // 绕过类型直接塞自由文本：模拟将来有人把上游错误体或对话内容传进来。
    await log.record({
      shell: 'claude', provider: 'kimi', code: 'key_rejected',
      note: 'Key sk-fixture-secret-0123456789 被拒；令牌 laixin-fixture-token-0123456789；客户问：帮我写一封辞职信',
      noteParams: ['sk-fixture-secret-0123456789', '帮我写一封辞职信']
    } as unknown as Parameters<typeof log.record>[0])
    const dumped = JSON.stringify([...f.data.values()])
    expect(dumped).not.toMatch(/sk-[A-Za-z0-9]/)
    expect(dumped).not.toContain('laixin-fixture-token')
    expect(dumped).not.toContain('辞职信')
    expect((await log.recent())[0].note).toBeUndefined()
  })

  it('模板 id 照常工作，参数只收短枚举与版本号，装不下凭据', async () => {
    const f = memoryFiles()
    const log = new FaultLog({ files: f.files, version: () => '0.4.9', now: () => day('2026-09-12'), dedupeMs: 0 })
    await log.record({ code: 'local_service_down', note: 'recovery_port_changed', noteParams: ['52341'] })
    await log.record({ shell: 'codex', code: 'shell_version_incompatible', note: 'shell_version_incompatible', noteParams: ['sk-fixture-secret-0123456789'] })
    const records = await log.recent()
    expect(faultLine(records[1])).toContain('已换到 52341')
    expect(records[0]).toMatchObject({ note: 'shell_version_incompatible' })
    expect(records[0].noteParams).toBeUndefined()
    expect(JSON.stringify(records)).not.toMatch(/sk-[A-Za-z0-9]/)
  })

  it('只收清单内的字段，来路不明的内容进不来', async () => {
    expect(sanitizeFaultRecord({ at: '2026-09-12T09:00:00.000Z', version: '0.4.9', code: 'not-a-code', shell: 'evil', network: 'DROP TABLE', note: '自由文本', prompt: '正文' }))
      .toEqual({ at: '2026-09-12T09:00:00.000Z', version: '0.4.9' })
    expect(sanitizeFaultRecord({ version: '0.4.9' })).toBeUndefined()
    expect(sanitizeFaultRecord('not a record')).toBeUndefined()
  })

  it('故障风暴不会把记录刷爆：同一条短时间内只记一次', async () => {
    const f = memoryFiles()
    let at = day('2026-09-12')
    const log = new FaultLog({ files: f.files, now: () => at, dedupeMs: 60_000 })
    for (let attempt = 0; attempt < 50; attempt++) { at += 1_000; await log.record({ shell: 'codex', provider: 'deepseek', code: 'timeout' }) }
    expect(await log.recent(100)).toHaveLength(1)
    at += 61_000
    await log.record({ shell: 'codex', provider: 'deepseek', code: 'timeout' })
    await log.record({ shell: 'codex', provider: 'deepseek', code: 'rate_limited' })
    expect(await log.recent(100)).toHaveLength(3)
  })

  it('超过保留天数与总量就删最旧的，单日太大砍掉前半', async () => {
    const old = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`2026-09-0${String(index + 1)}.jsonl`,
      `${JSON.stringify({ at: `2026-09-0${String(index + 1)}T09:00:00.000Z`, version: '0.4.9', code: 'timeout' })}\n`]))
    const f = memoryFiles(old)
    const log = new FaultLog({ files: f.files, now: () => day('2026-09-12'), days: 3 })
    await log.record({ code: 'network_error' })
    expect([...f.data.keys()].sort()).toEqual(['2026-09-04.jsonl', '2026-09-05.jsonl', '2026-09-12.jsonl'])

    const big = memoryFiles({ '2026-09-12.jsonl': Array.from({ length: 40 }, () => `${JSON.stringify({ at: '2026-09-12T09:00:00.000Z', version: '0.4.9', code: 'timeout' })}\n`).join('') })
    const trimming = new FaultLog({ files: big.files, now: () => day('2026-09-12'), fileBytes: 600, dedupeMs: 0 })
    await trimming.record({ code: 'network_error' })
    expect(big.data.get('2026-09-12.jsonl')!.length).toBeLessThanOrEqual(600)
    expect((await trimming.recent(100)).length).toBeGreaterThan(0)
  })

  it('重开工具箱后记录还在，读的时候再清洗一遍，被人改过的行不会带脏东西进摘要', async () => {
    const root = mkdtempSync(join(tmpdir(), 'laixin-fault-log-'))
    roots.push(root)
    const files = createFaultLogFiles(root)
    const first = new FaultLog({ files, version: () => '0.4.9', now: () => day('2026-09-12') })
    await first.record({ shell: 'hermes', provider: 'deepseek', code: 'balance_or_access' })

    const reopened = new FaultLog({ files, version: () => '0.4.9', now: () => day('2026-09-12') })
    expect((await reopened.recent())[0]).toMatchObject({ shell: 'hermes', code: 'balance_or_access' })
    expect(await readFile(join(root, '2026-09-12.jsonl'), 'utf8')).toContain('balance_or_access')

    await files.append('2026-09-12.jsonl', `${JSON.stringify({ at: '2026-09-12T10:00:00.000Z', version: '0.4.9', code: 'timeout', note: '客户原话 sk-tampered-secret-0123456789', prompt: '整段对话正文' })}\n`)
    const records = await reopened.recent()
    expect(JSON.stringify(records)).not.toContain('sk-tampered-secret')
    expect(JSON.stringify(records)).not.toContain('整段对话正文')
    await expect(files.read('../../etc/passwd')).resolves.toBeUndefined()
    await expect(files.append('not-a-day.jsonl', 'x')).rejects.toThrow('FAULT_LOG_NAME_INVALID')
  })

  it('记录失败从不把调用方拖下水', async () => {
    const log = new FaultLog({ files: { ...memoryFiles().files, append: async () => { throw new Error('fixture disk full') } } })
    await expect(log.record({ code: 'timeout' })).resolves.toBeUndefined()
  })
})
