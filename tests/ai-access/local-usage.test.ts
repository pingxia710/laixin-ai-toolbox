import { chmod, mkdtemp, mkdir, rm, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readKimiCodeLocalUsage, readZcodeLocalUsage } from '../../app/main/ai-access/local-usage'

const NOW = Date.parse('2026-09-12T08:00:00Z')
const inside = NOW - 2 * 86_400_000
const outside = NOW - 30 * 86_400_000
const homes: string[] = []

afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))) })

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'laixin-local-usage-'))
  homes.push(home)
  return home
}

async function writeWire(home: string, session: string, agent: string, lines: readonly unknown[], mtime = NOW): Promise<void> {
  const directory = join(home, '.kimi-code', 'sessions', 'wd_test', session, 'agents', agent)
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'wire.jsonl')
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  await utimes(file, new Date(mtime), new Date(mtime))
}

const usageRecord = (time: number, output = 100) => ({ type: 'usage.record', agentId: 'main', model: 'kimi-code/k3', usageScope: 'turn', time,
  usage: { inputOther: 1_000, output, inputCacheRead: 500, inputCacheCreation: 0 } })

describe('Kimi Code 本机用量', () => {
  it('按 usage.record 汇总 Token、按 prompt.accepted 数对话，只统计窗口内的', async () => {
    const home = await temporaryHome()
    await writeWire(home, 'session_a', 'main', [
      { type: 'prompt.accepted', time: inside },
      usageRecord(inside, 100),
      { type: 'prompt.accepted', time: outside },
      usageRecord(outside, 9_999),
      { type: 'token_counting.measured', tokens: 1, time: inside }
    ])
    // 子 agent 也烧 Token，但它没有 prompt.accepted：⛔ 被算成一次对话。
    await writeWire(home, 'session_a', 'agent-0', [usageRecord(inside, 200)])
    const result = await readKimiCodeLocalUsage(home, { now: () => NOW })
    expect(result.status).toBe('local')
    expect(result.usage).toMatchObject({ days: 7, conversations: 1, requests: 2, tokens: 3_300, newestAt: inside })
  })

  it('整份文件都比窗口旧就跳过，不白读一遍盘', async () => {
    const home = await temporaryHome()
    await writeWire(home, 'session_old', 'main', [{ type: 'prompt.accepted', time: inside }, usageRecord(inside)], outside)
    expect(await readKimiCodeLocalUsage(home, { now: () => NOW })).toMatchObject({ status: 'no-records', usage: null })
  })

  it('没装、装了没记录分别说清楚，⛔ 拿 0 当统计结果', async () => {
    const empty = await temporaryHome()
    expect(await readKimiCodeLocalUsage(empty, { now: () => NOW })).toMatchObject({ status: 'not-installed', usage: null })
    const home = await temporaryHome()
    await writeWire(home, 'session_b', 'main', [{ type: 'turn.ended', time: inside }])
    expect(await readKimiCodeLocalUsage(home, { now: () => NOW })).toMatchObject({ status: 'no-records', usage: null })
  })

  // 64 MiB 以上的会话文件本来就该跳过（⛔ 拖住界面），但跳过之后必须说出来：
  // 原来单个超大文件会变成「本机还没有这个软件的使用记录」，重度用户被告知自己没用过。
  it('超大会话文件被跳过时说读不出来，⛔ 报成「没有记录」', async () => {
    const home = await temporaryHome()
    await writeWire(home, 'session_big', 'main', [{ type: 'prompt.accepted', time: inside }, usageRecord(inside)])
    const file = join(home, '.kimi-code', 'sessions', 'wd_test', 'session_big', 'agents', 'main', 'wire.jsonl')
    await truncate(file, 64 * 1024 * 1024 + 1)
    await utimes(file, new Date(NOW), new Date(NOW))
    expect(await readKimiCodeLocalUsage(home, { now: () => NOW })).toMatchObject({ status: 'unreadable', usage: null })
  })

  it('一部分读到、一部分被跳过时，统计照给但要标明是残缺的', async () => {
    const home = await temporaryHome()
    await writeWire(home, 'session_small', 'main', [{ type: 'prompt.accepted', time: inside }, usageRecord(inside, 100)])
    await writeWire(home, 'session_big', 'main', [usageRecord(inside, 100)])
    const big = join(home, '.kimi-code', 'sessions', 'wd_test', 'session_big', 'agents', 'main', 'wire.jsonl')
    await truncate(big, 64 * 1024 * 1024 + 1)
    await utimes(big, new Date(NOW), new Date(NOW))
    const result = await readKimiCodeLocalUsage(home, { now: () => NOW })
    expect(result).toMatchObject({ status: 'local', partial: true })
    expect(result.usage).toMatchObject({ conversations: 1, requests: 1 })
  })

  it('会话目录读不动（权限）时说读不出来，⛔ 吞成「没有记录」', async () => {
    const home = await temporaryHome()
    await writeWire(home, 'session_d', 'main', [{ type: 'prompt.accepted', time: inside }, usageRecord(inside)])
    const sessions = join(home, '.kimi-code', 'sessions')
    await chmod(sessions, 0o000)
    try {
      expect(await readKimiCodeLocalUsage(home, { now: () => NOW })).toMatchObject({ status: 'unreadable', usage: null })
    } finally { await chmod(sessions, 0o700) }
  })

  it('半行坏 JSON 不影响其余统计', async () => {
    const home = await temporaryHome()
    const directory = join(home, '.kimi-code', 'sessions', 'wd_test', 'session_c', 'agents', 'main')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'wire.jsonl'), `{"broken"\n${JSON.stringify(usageRecord(inside))}\n`, 'utf8')
    expect((await readKimiCodeLocalUsage(home, { now: () => NOW })).usage).toMatchObject({ requests: 1, tokens: 1_600 })
  })
})

async function writeZcodeDatabase(home: string, rows: readonly { started_at: number; tokens: number }[], turns = rows.length): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite')
  const directory = join(home, '.zcode', 'cli', 'db')
  await mkdir(directory, { recursive: true })
  const database = new DatabaseSync(join(directory, 'db.sqlite'))
  database.exec('create table model_usage (id text primary key, session_id text, started_at integer, computed_total_tokens integer)')
  database.exec('create table turn_usage (session_id text, turn_id text, started_at integer)')
  rows.forEach((row, index) => {
    database.prepare('insert into model_usage values (?, ?, ?, ?)').run(`m${String(index)}`, 's', row.started_at, row.tokens)
  })
  for (let index = 0; index < turns; index += 1) {
    database.prepare('insert into turn_usage values (?, ?, ?)').run('s', `t${String(index)}`, rows[index]?.started_at ?? inside)
  }
  database.close()
}

describe('智谱 ZCode 本机用量', () => {
  it('从 model_usage 汇总请求数与 Token，从 turn_usage 数对话，窗口外的不算', async () => {
    const home = await temporaryHome()
    await writeZcodeDatabase(home, [{ started_at: inside, tokens: 1_000 }, { started_at: inside + 1_000, tokens: 2_500 }, { started_at: outside, tokens: 9_999 }], 3)
    const result = await readZcodeLocalUsage(home, { now: () => NOW })
    expect(result.status).toBe('local')
    expect(result.usage).toMatchObject({ days: 7, requests: 2, tokens: 3_500, conversations: 2, newestAt: inside + 1_000 })
  })

  it('没装说没装，装了但窗口内没记录说没记录', async () => {
    expect(await readZcodeLocalUsage(await temporaryHome(), { now: () => NOW })).toMatchObject({ status: 'not-installed' })
    const home = await temporaryHome()
    await writeZcodeDatabase(home, [{ started_at: outside, tokens: 10 }], 1)
    expect(await readZcodeLocalUsage(home, { now: () => NOW })).toMatchObject({ status: 'no-records', usage: null })
  })

  it('库打不开就说读不出来，⛔ 报成没用过', async () => {
    const home = await temporaryHome()
    await mkdir(join(home, '.zcode', 'cli', 'db'), { recursive: true })
    await writeFile(join(home, '.zcode', 'cli', 'db', 'db.sqlite'), 'not a database', 'utf8')
    expect(await readZcodeLocalUsage(home, { now: () => NOW })).toMatchObject({ status: 'unreadable', usage: null })
  })

  it('老版本没有 turn_usage 时对话数记 0，其余照常显示', async () => {
    const home = await temporaryHome()
    const { DatabaseSync } = await import('node:sqlite')
    const directory = join(home, '.zcode', 'cli', 'db')
    await mkdir(directory, { recursive: true })
    const database = new DatabaseSync(join(directory, 'db.sqlite'))
    database.exec('create table model_usage (id text primary key, started_at integer, computed_total_tokens integer)')
    database.prepare('insert into model_usage values (?, ?, ?)').run('m0', inside, 700)
    database.close()
    expect((await readZcodeLocalUsage(home, { now: () => NOW })).usage).toMatchObject({ requests: 1, tokens: 700, conversations: 0 })
  })
})
