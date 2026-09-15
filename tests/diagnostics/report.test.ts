import { describe, expect, it } from 'vitest'
import { buildDiagnosticsText } from '../../app/main/diagnostics/report'

it('网络修复进入客服摘要，只选取展示字段，不输出连接令牌或原配置', () => {
  const text = buildDiagnosticsText({ collectedAt: '2026-09-12 22:00', errors: [], networkRepair: {
    phase: 'finished', outcome: 'still_failing', code: '已有代理控制', message: '其他代理或 PAC 正在使用',
    startedAt: '21:59', finishedAt: '22:00', sessionToken: 'DO_NOT_COPY_INTERNAL_TOKEN', originalConfig: 'DO_NOT_COPY_CONFIG'
  } })
  expect(text).toContain('本次网络修复：21:59 → 22:00')
  expect(text).toContain('其他代理或 PAC 正在使用')
  expect(text).not.toContain('DO_NOT_COPY')
})

describe('一键诊断文本', () => {
  it('汇总软件、网络、已装 AI、模型接入、余额与更新；从不包含 Key', () => {
    const text = buildDiagnosticsText({
      collectedAt: '2026-09-11 23:00',
      app: { version: '0.4.6', platform: 'darwin', architecture: 'arm64', packaged: true },
      tunnel: { state: '已连', message: '出口已复验', currentConfig: '版本 3', nodeLabel: 'node-a', exitIp: '203.0.113.8', expiresAt: '2026-10-01', lastVerifiedAt: '23:00', authorization: '已核验', backend: '已接入', unrestored: '', componentMissing: '' },
      network: { layers: [{ label: '基础网络', state: 'ok', detail: '120ms' }, { label: '通道出口', state: 'fail', detail: '超时' }] },
      shells: [{ id: 'codex', label: 'Codex', installed: true, version: '0.153.4', latest: '0.160.0', updatable: true, location: '/opt/homebrew/bin/codex' }, { id: 'zcode', label: '智谱 ZCode', installed: null, version: '', latest: '' }],
      access: { shells: { codex: { selected: 'deepseek', providerKeys: { deepseek: true, kimi: false } } }, attempt: { shell: 'codex', provider: 'deepseek', ok: false, code: 'shell_version_incompatible', notice: '请安装 2.1.153', at: '2026-09-11T15:00:00Z' } },
      service: { running: true, baseUrl: 'http://127.0.0.1:47000', usage: [{ shell: 'codex', provider: 'deepseek', tested: '2026-09-11T15:00:00Z', configured: '2026-09-11T15:00:05Z', observedClientCall: null }, { shell: 'claude', provider: null, tested: null, configured: null, observedClientCall: null }], requests: [{ at: '15:01', shell: 'codex', provider: 'deepseek', model: 'deepseek-v4-flash', ok: true, status: 200, durationMs: 812 }] },
      desktop: { update: { state: 'current', version: '', message: '当前已是最新可用版本。' }, preferences: { autoUpdate: true }, backgroundAvailable: true },
      balances: [{ provider: 'deepseek', supported: true, total: 12.35, currency: 'CNY', peak: { peak: false, label: '现在是空闲时段，按半价计费' } }],
      recipesVersion: 1, install: { phase: 'failed', shell: 'claude-code', message: 'command-failed' }, errors: ['networkdiagnostics.run: timeout'],
      faults: [
        { at: '2026-09-11T15:10:00Z', version: '0.4.9', shell: 'codex', provider: 'deepseek', code: 'key_rejected', action: 'retest', outcome: 'still_failing' },
        { at: '2026-09-11T15:05:00Z', version: '0.4.9', network: 'AI_DIAG_TUNNEL_REQUIRED' }
      ]
    })
    for (const expected of ['0.4.6', '已连', '203.0.113.8', '通道出口：fail 超时', 'Codex：已装 0.153.4 · 最新 0.160.0 · 可更新', '智谱 ZCode：无法判断', 'codex：当前 deepseek · 已存 Key：deepseek', 'shell_version_incompatible 请安装 2.1.153', '运行中 http://127.0.0.1:47000', '812ms', '12.35 CNY', '半价', '最近安装任务：claude-code failed command-failed', '自动更新：开', 'networkdiagnostics.run: timeout', '【最近故障与已试过的处理】', '试过「重新测试」', '仍有问题', 'AI_DIAG_TUNNEL_REQUIRED', 'codex 接入进度：接口测试 2026-09-11T15:00:00Z · 配置已写 2026-09-11T15:00:05Z · 观察到软件调用 尚未观察到']) expect(text).toContain(expected)
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/)
  })
  it('什么都没读到也能出一页，不崩', () => {
    const text = buildDiagnosticsText({ collectedAt: 'now', errors: [] })
    expect(text).toContain('未读到')
    expect(text).toContain('【已装的 AI】')
    expect(text).toContain('本机没有留存的故障记录。')
  })
})
