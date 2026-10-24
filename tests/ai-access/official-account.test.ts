import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseClaudeOfficialAccount, readClaudeOfficialAccount, readCodexOfficialAccount } from '../../app/main/ai-access/official-account'
import { writeFile } from 'node:fs/promises'
import { BridgeRegistry } from '../../app/main/bridge/bridge-registry'
import { registerOfficialAccountActions } from '../../app/main/actions/official-account'

describe('官方套餐账号确认', () => {
  it('只确认 Codex 身份，不查询用量；只返回脱敏身份', async () => {
    const root = await mkdtemp(join(tmpdir(), 'official-account-'))
    const requests = join(root, 'requests.jsonl')
    const account = await readCodexOfficialAccount([{ executable: process.execPath, args: [resolve('tests/codex-usage/fixtures/server.mjs')] }], root,
      { ...process.env, USAGE_FIXTURE_REQUESTS: requests })
    expect(account).toEqual({ state: 'signed-in', accountLabel: 'de***@example.test', plan: 'plus', accountKey: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect((await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line).method)).toEqual(['initialize', 'initialized', 'account/read'])
  })
  it('候选二进制按顺序回退：装 ChatGPT.app 的机器上自带 codex 拉不到额度时，退到 npm 全局包的正式版', async () => {
    const broken = { executable: process.execPath, args: [resolve('tests/codex-usage/fixtures/server.mjs'), 'exit'] }
    const working = { executable: process.execPath, args: [resolve('tests/codex-usage/fixtures/server.mjs')] }
    expect(await readCodexOfficialAccount([broken, working], tmpdir()).then(account => account.state)).toBe('signed-in')
    expect(await readCodexOfficialAccount([broken], tmpdir()).then(account => account.state)).toBe('unavailable')
  })
  it.each([['signed-out', 'signed-out'], ['api-key', 'unsupported'], ['malformed', 'unavailable']] as const)('Codex %s 与其他状态区分', async (mode, state) => {
    expect(await readCodexOfficialAccount([{ executable: process.execPath, args: [resolve('tests/codex-usage/fixtures/server.mjs'), mode] }], tmpdir())).toEqual({ state, accountLabel: null, plan: null })
  })
  it('未安装不能当成已经登录', async () => {
    expect((await readCodexOfficialAccount(null, tmpdir())).state).toBe('not-installed')
    expect((await readCodexOfficialAccount([], tmpdir())).state).toBe('not-installed')
  })
  it('Claude 只认官方套餐登录，不把 API 登录或坏数据当成功', () => {
    expect(parseClaudeOfficialAccount(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'demo@example.test', subscriptionType: 'max', accessToken: 'fixture-secret' })))
      .toEqual({ state: 'signed-in', accountLabel: 'de***@example.test', plan: 'max', accountKey: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(parseClaudeOfficialAccount('{"loggedIn":false}').state).toBe('signed-out')
    expect(parseClaudeOfficialAccount('{"loggedIn":true,"authMethod":"api_key"}').state).toBe('unsupported')
    expect(parseClaudeOfficialAccount('not json').state).toBe('unavailable')
  })
  it('桥只允许 Codex 和 Claude，拒绝任意路径与多余参数', async () => {
    const registry = new BridgeRegistry()
    registerOfficialAccountActions(registry, async () => ({ state: 'signed-out', accountLabel: null, plan: null }),
      { key: async () => 'a'.repeat(64) })
    await expect(registry.execute('officialaccount.read', { shell: 'codex' })).resolves.toHaveProperty('snapshot')
    await expect(registry.execute('officialaccount.read', { shell: '../private' })).rejects.toMatchObject({ code: 'ACTION_FAILED' })
    await expect(registry.execute('officialaccount.read', { shell: 'claude', path: '/private' })).rejects.toMatchObject({ code: 'ACTION_PARAMS_INVALID' })
  })
  it('Claude 身份查询挂死且无视 SIGTERM 时，超时后照样返回并回收子进程', async () => {
    const root = await mkdtemp(join(tmpdir(), 'official-account-hang-'))
    const hang = join(root, 'hang.cjs')
    const pidFile = join(root, 'pid')
    await writeFile(hang, `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`)
    const executable = join(root, 'claude')
    await writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(hang)} "$@"\n`, { mode: 0o755 })
    const started = Date.now()
    // 高负载下 node 起来要几百毫秒：时限放到 2 s，先等子进程写出 pid 再看它有没有被收掉（⛔ 用 400 ms 赌启动速度）。
    const pending = readClaudeOfficialAccount(executable, root, process.env, 2000)
    let pid = 0
    for (let i = 0; i < 80 && !pid; i++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
    }
    expect(pid).toBeGreaterThan(0)
    const account = await pending
    expect(account.state).toBe('unavailable')
    expect(Date.now() - started).toBeLessThan(10000)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(() => process.kill(pid, 0)).toThrow()
  })

})
