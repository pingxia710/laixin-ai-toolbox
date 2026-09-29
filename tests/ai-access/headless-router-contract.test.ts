import { describe, expect, it, vi } from 'vitest'
import { AI_ROUTER_LABEL, AI_ROUTER_TASK, aiRouterMacAgentPath, aiRouterMacPlist, aiRouterWinTaskXml } from '../../app/main/ai-access/router-resident'
import { RESIDENT_LABEL, RESIDENT_TASK } from '../../app/main/tunnel/platform/resident'
import { emitCodexProviderKey } from '../../app/main/ai-access/codex-workspace-key-reader'
import type { AiAccessState } from '../../app/main/ai-access/service'

const token = 'a'.repeat(64)
const state: AiAccessState = {
  version: 1, selected: {}, codexMode: 'multi',
  codexMultiRelay: { port: 43210, identitySecret: 'b'.repeat(64) },
  shellKeys: { codex: { deepseek: 'sk-fixture-private-key-0123456789' } },
  codexMultiModelPool: [{ provider: 'deepseek', model: 'deepseek-flash', internalModelId: 'laixin.deepseek.deepseek-flash' }]
}

describe('API-15R-B router contract', () => {
  it('平台常驻实体与网络守护逐字段隔离', () => {
    expect(AI_ROUTER_LABEL).not.toBe(RESIDENT_LABEL)
    expect(AI_ROUTER_TASK).not.toBe(RESIDENT_TASK)
    const spec = { executable: '/Applications/Laixin.app/Contents/MacOS/Laixin', logDir: '/tmp/router-log' }
    const plist = aiRouterMacPlist(spec)
    expect(plist).toContain(AI_ROUTER_LABEL)
    expect(aiRouterMacAgentPath('/Users/fixture')).toBe(`/Users/fixture/Library/LaunchAgents/${AI_ROUTER_LABEL}.plist`)
    expect(plist).toContain(`<key>Label</key><string>${AI_ROUTER_LABEL}</string>`)
    expect(plist).toContain('<key>ProgramArguments</key><array>')
    expect(plist).toContain(`<string>${spec.executable}</string>`)
    expect(plist).toContain('<string>--laixin-ai-router</string>')
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>')
    expect(plist).toContain(`<key>StandardErrorPath</key><string>${spec.logDir}/ai-router.log</string>`)
    expect(plist).not.toContain('tunnel-daemon.log')
    expect(plist).not.toContain(RESIDENT_LABEL)
    const xml = aiRouterWinTaskXml({ executable: 'C:\\Program Files\\Laixin\\Laixin.exe', logDir: 'C:\\Users\\Test\\AppData\\Local\\Laixin' })
    expect(xml).toContain(`<URI>${AI_ROUTER_TASK}</URI>`)
    expect(xml).toContain('<Command>C:\\Program Files\\Laixin\\Laixin.exe</Command>')
    expect(xml).toContain('<Arguments>&quot;--laixin-ai-router&quot;</Arguments>')
    expect(xml).toContain('<LogonTrigger><Enabled>true</Enabled></LogonTrigger>')
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>')
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(xml).toContain('<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>')
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>')
    expect(xml).not.toContain(RESIDENT_TASK)
    expect(xml).not.toContain(token)
    expect(xml).not.toContain('sk-fixture-private-key')
    expect(plist).not.toContain(token)
    expect(plist).not.toContain('sk-fixture-private-key')
  })

  it('router 未就绪时认证命令不得输出旧 token', async () => {
    const write = vi.fn()
    const store = { read: async () => state, write: vi.fn() }
    await expect(emitCodexProviderKey('multi', store, write, { ensureReady: async () => false })).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('池条目缺 Key 或模式已关闭时认证不唤醒也不输出', async () => {
    const write = vi.fn()
    const ensureReady = vi.fn(async () => false as const)
    for (const invalid of [{ ...state, shellKeys: undefined }, { ...state, codexMode: 'single' as const }]) {
      await expect(emitCodexProviderKey('multi', { read: async () => invalid }, write, { ensureReady })).resolves.toBe(false)
    }
    expect(ensureReady).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
})
