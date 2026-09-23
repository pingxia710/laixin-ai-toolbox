import { afterEach, describe, expect, it } from 'vitest'
import { shellConfigFixture } from './fixtures/shell-config'

const fixtures: { dispose(): Promise<void> }[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose())) })

async function connected(shells: readonly ('codex' | 'claude' | 'hermes')[] = ['codex']) {
  const f = shellConfigFixture()
  fixtures.push(f)
  for (const shell of shells) {
    await f.service.saveProviderKey(shell, 'deepseek', `sk-fixture-consistency-${shell}-0123456789`)
    await f.service.useProvider(shell, 'deepseek')
  }
  return f
}

describe('配置一致性持续核对', () => {
  it('刚写完是一致的；被别的工具改掉就报被外部改动，且工具箱 ⛔ 自动覆盖回去', async () => {
    const f = await connected()
    expect(await f.service.verifyConfigurations()).toMatchObject({ codex: 'ok', claude: 'not-managed', hermes: 'not-managed' })

    // 模拟 CC Switch 之类的工具把地址改到别处。
    const before = f.data.get(f.codexPath)!
    const tampered = before.replace(/base_url = "[^"]*"/, 'base_url = "http://127.0.0.1:59999/other-tool/v1"')
    expect(tampered).not.toBe(before)
    f.data.set(f.codexPath, tampered)

    expect(await f.service.verifyConfigurations()).toMatchObject({ codex: 'modified-externally' })
    expect(f.data.get(f.codexPath)).toBe(tampered)
    expect((await f.service.serviceStatus()).usage.find(stage => stage.shell === 'codex')).toMatchObject({ configuration: 'modified-externally' })
    expect(f.faults.some(fault => fault.shell === 'codex' && fault.code === 'configuration_failed')).toBe(true)
  })

  it('外部改动配置后，先前观察到的软件调用也立即作废，不能在重写前继续显示正在使用', async () => {
    const f = await connected()
    const relay = f.state().relay!
    const response = await fetch(`${f.gateway.baseUrl}/codex/deepseek/v1/responses`, {
      method: 'POST', headers: { authorization: `Bearer ${relay.token}` }, body: JSON.stringify({ input: 'fixture', stream: true })
    })
    await response.text()
    expect((await f.service.serviceStatus()).usage.find(stage => stage.shell === 'codex')?.observedClientCall).toEqual(expect.any(String))

    const before = f.data.get(f.codexPath)!
    f.data.set(f.codexPath, before.replace(/base_url = "[^"]*"/, 'base_url = "http://127.0.0.1:59999/other-tool/v1"'))
    await f.service.verifyConfigurations()

    const stage = (await f.service.serviceStatus()).usage.find(item => item.shell === 'codex')!
    expect(stage).toMatchObject({ configuration: 'modified-externally', observedClientCall: null, lastObservedClientCall: null })
    expect(f.gateway.clientAcceptances().codex).toBeUndefined()
  })

  it('客户在托管段之外自己加的设置不算被改动', async () => {
    const f = await connected()
    f.data.set(f.codexPath, `${f.data.get(f.codexPath)!}\n[projects."/customer"]\nmodel = "customer-choice"\n`)
    expect(await f.service.verifyConfigurations()).toMatchObject({ codex: 'ok' })
  })

  it('重新写入配置之后回到一致，客户自己的设置仍在', async () => {
    const f = await connected()
    f.data.set(f.codexPath, `${f.data.get(f.codexPath)!.replace(/model_reasoning_effort = "[^"]*"/, 'model_reasoning_effort = "low"')}\n[projects."/customer"]\nmodel = "customer-choice"\n`)
    expect(await f.service.verifyConfigurations()).toMatchObject({ codex: 'modified-externally' })

    const result = await f.service.remedy('codex', 'reapply')
    expect(result).toMatchObject({ action: 'reapply', outcome: 'recovered' })
    expect(await f.service.verifyConfigurations()).toMatchObject({ codex: 'ok' })
    expect(f.data.get(f.codexPath)).toContain('[projects."/customer"]')
    expect(f.data.get(f.codexPath)).toContain('model_reasoning_effort = "high"')
  })

  it('托管段整段被删掉报「不见了」，不是「被改过」', async () => {
    const f = await connected()
    f.data.set(f.codexPath, 'model = "gpt-5.5"\n')
    expect(await f.service.verifyConfigurations()).toMatchObject({ codex: 'missing' })
  })

  it('读不出配置时报「不能判断」，⛔ 猜成没被改', async () => {
    const f = await connected()
    f.file.read = async () => { throw new Error('fixture unreadable config') }
    expect(await f.service.verifyConfigurations()).toMatchObject({ codex: 'unknown' })
  })

  it('Claude 与 Hermes 各自独立核对，一个被改不影响另一个', async () => {
    const f = await connected(['claude', 'hermes'])
    expect(await f.service.verifyConfigurations()).toMatchObject({ claude: 'ok', hermes: 'ok', codex: 'not-managed' })

    const settings = JSON.parse(f.data.get(f.claudePath)!) as { env: Record<string, string> }
    settings.env.ANTHROPIC_MODEL = 'someone-elses-model'
    f.data.set(f.claudePath, JSON.stringify(settings, null, 2))
    expect(await f.service.verifyConfigurations()).toMatchObject({ claude: 'modified-externally', hermes: 'ok' })

    f.hermesSettings.set('model.default', 'someone-elses-model')
    f.syncHermesConfig()
    expect(await f.service.verifyConfigurations()).toMatchObject({ claude: 'modified-externally', hermes: 'modified-externally' })
  })

  it('切回官方之后这个壳不再参与核对', async () => {
    const f = await connected()
    await f.service.useOfficial('codex')
    expect(await f.service.verifyConfigurations()).toMatchObject({ codex: 'not-managed' })
    expect(f.state().shellFingerprints?.codex).toBeUndefined()
  })

  // Phase 2 ⑥:切换进行到一半(claude 的托管段已摘除、状态还没落盘)时,并发核对 ⛔ 把工具箱
  // 自己的改写看成「被外部改动」——那还会顺手作废刚攒下的客户端验收证据。核对必须进串行队列排队。
  it('核对与切换并发时排在队列里,⛔ 半路上的改写被报成「被外部改动」', async () => {
    const f = await connected(['claude'])
    // 先建立一次 claude 的真实客户端调用,让「验收证据被误作废」可观察。
    const relay = f.state().relay!
    const response = await fetch(`${f.gateway.baseUrl}/claude/deepseek/v1/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'fixture' }], stream: true })
    })
    await response.text()
    expect(f.gateway.clientAcceptances().claude).toBeDefined()

    // 切换把 claude 托管段摘除(settings.json 被移除/改写)的那一刻开闸:verify 停在闸上的那次读
    // 会读到改写后的文件,而它手里的状态快照还是旧指纹——正是生产里「切换窗口期」的相对时序。
    const originalFileWrite = f.file.write.bind(f.file)
    const originalFileRemove = f.file.remove.bind(f.file)
    let claudeRewritten = false
    let releaseClaudeRead!: () => void
    const claudeReadGate = new Promise<void>(resolve => { releaseClaudeRead = resolve })
    const openGate = (): void => { if (!claudeRewritten) { claudeRewritten = true; releaseClaudeRead() } }
    f.file.write = async (path, contents) => {
      const result = await originalFileWrite(path, contents)
      if (path === f.claudePath) openGate()
      return result
    }
    f.file.remove = async (path) => {
      const result = await originalFileRemove(path)
      if (path === f.claudePath) openGate()
      return result
    }
    // 只闸核对的第一次 claude 读(后续读不闸,⛔ 串行队列修复后核对本就排在切换后面)。
    const originalFileRead = f.file.read.bind(f.file)
    let gatedOnce = false
    f.file.read = async (path) => {
      if (path === f.claudePath && !gatedOnce) {
        gatedOnce = true
        if (!claudeRewritten) await Promise.race([claudeReadGate, new Promise(resolve => setTimeout(resolve, 2_000))])
      }
      return originalFileRead(path)
    }

    // 核对先入队(此刻队列为空,立刻开跑,停在 claude 的闸上);切换随后入队。
    const verify = f.service.verifyConfigurations()
    await new Promise(resolve => setTimeout(resolve, 5))
    const switchClaude = f.service.useOfficial('claude')
    const report = await verify
    // 切换还没等完就看核对当时的结论:⛔ 用切换完成后的状态当判据(路由下线会合法清掉验收证据)。
    expect(['ok', 'not-managed']).toContain(report.claude)
    expect(f.faults.some(fault => fault.code === 'configuration_failed')).toBe(false)
    await switchClaude
  })

  it('指纹只存哈希，状态里 ⛔ 出现配置原文或本机令牌', async () => {
    const f = await connected()
    const token = f.state().relay!.token
    expect(f.state().shellFingerprints?.codex).toMatch(/^[a-f0-9]{64}$/)
    const serialized = JSON.stringify({ state: { ...f.state(), relay: undefined }, status: await f.service.serviceStatus() })
    expect(serialized).not.toContain(token)
    expect(serialized).not.toContain('base_url')
  })
})

describe('接管前核对 · 别的工具留下的死地址（第 7 条）', () => {
  it('claude 配置指着本机没人听的端口时，核对结果点名端口、说清是别的工具留下的', async () => {
    const f = shellConfigFixture({ version: 1, selected: {} }, { isPortListening: async () => false })
    fixtures.push(f)
    f.data.set(f.claudePath, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:57547', ANTHROPIC_AUTH_TOKEN: 'sk-ccswitch-leftover-0123456789' },
      permissions: { allow: ['Bash(git status)'] }
    }))
    const report = await f.service.verifyConfigurations()
    expect(report.claude).toBe('not-managed')
    const spoken = (report.notes ?? []).join('\n')
    expect(spoken).toContain('57547')
    expect(spoken).toContain('别的工具')
    expect(spoken).toContain('备份')
    // ⛔ 把客户原来那把残留 Key 原文带出来。
    expect(spoken).not.toContain('sk-ccswitch-leftover')
  })

  it('死地址里内嵌的凭据 ⛔ 跟着 notes 过桥（第 7 条返修）', async () => {
    const f = shellConfigFixture({ version: 1, selected: {} }, { isPortListening: async () => false })
    fixtures.push(f)
    f.data.set(f.claudePath, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://user:sk-embedded-0123456789@127.0.0.1:57548/v1' }
    }))
    const report = await f.service.verifyConfigurations()
    const spoken = JSON.stringify(report)
    expect(spoken).toContain('57548')
    expect(spoken).not.toContain('sk-embedded-0123456789')
    expect(spoken).not.toContain('user:')
  })

  it('端口有人在听、不是本机地址、或读不出配置时都不吭声', async () => {
    const f = shellConfigFixture({ version: 1, selected: {} }, { isPortListening: async () => true })
    fixtures.push(f)
    f.data.set(f.claudePath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:57547' } }))
    expect(await f.service.verifyConfigurations()).not.toHaveProperty('notes')
    f.data.set(f.claudePath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://proxy.corp.example:8080' } }))
    expect(await f.service.verifyConfigurations()).not.toHaveProperty('notes')
  })

  it('codex 的 TOML 和 hermes 的 yaml 里留着死地址也一样报', async () => {
    const f = shellConfigFixture({ version: 1, selected: {} }, { isPortListening: async () => false })
    fixtures.push(f)
    f.data.set(f.codexPath, 'model = "gpt-5"\nmodel_provider = "ccswitch"\n\n[model_providers.ccswitch]\nbase_url = "http://127.0.0.1:57548/v1"\n')
    f.hermesSettings.set('model.base_url', 'http://localhost:57549')
    f.syncHermesConfig()
    const spoken = (await f.service.verifyConfigurations()).notes ?? []
    expect(spoken.join('\n')).toContain('57548')
    expect(spoken.join('\n')).toContain('57549')
  })
})
