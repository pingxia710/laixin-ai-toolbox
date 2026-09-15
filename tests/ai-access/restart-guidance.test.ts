import { describe, expect, it } from 'vitest'
import { createRestartGuidanceReader, restartMessage } from '../../app/main/ai-access/restart-guidance'

describe('切换后的原生软件提示', () => {
  it('按三个软件的实际重读方式给出不同提示', () => {
    expect(restartMessage('codex', 'running')).toContain('关闭并重新打开')
    expect(restartMessage('claude', 'running')).toContain('新开一个会话')
    expect(restartMessage('hermes', 'running')).toContain('当前会话生效')
  })

  it('macOS/Linux 只用固定 pgrep 名称检查，返回安全的存活结论', async () => {
    const calls: { command: string; args: readonly string[] }[] = []
    const reader = createRestartGuidanceReader({ platform: 'darwin', readCommand: async (command, args) => {
      calls.push({ command, args })
      if (args[1] === 'ChatGPT') return '123\n'
      throw Object.assign(new Error('not found'), { code: 1 })
    } })

    await expect(reader.read('codex')).resolves.toMatchObject({ shell: 'codex', process: 'running' })
    expect(calls).toEqual([
      { command: '/usr/bin/pgrep', args: ['-x', 'codex'] },
      { command: '/usr/bin/pgrep', args: ['-x', 'Codex'] },
      { command: '/usr/bin/pgrep', args: ['-x', 'ChatGPT'] }
    ])
  })

  it('Windows 只读固定 tasklist；继承的 SystemRoot 不能改写执行路径', async () => {
    const calls: string[] = []
    const unsafeOptions = { platform: 'win32' as const, systemRoot: 'D:\\untrusted', readCommand: async (command: string) => {
      calls.push(command)
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    } }
    const reader = createRestartGuidanceReader(unsafeOptions)
    await expect(reader.read('claude')).resolves.toMatchObject({ shell: 'claude', process: 'unknown' })
    expect(calls).toEqual(['C:\\Windows\\System32\\tasklist.exe'])
  })
})
