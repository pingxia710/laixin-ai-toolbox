import { describe, expect, it } from 'vitest'
import { codexWorkspaceOptions, codexWorkspaceResultMessage, readCodexWorkspaceOpenResult } from '../../app/renderer/src/platform/codex-workspaces'

describe('Codex 四来源工作窗口界面', () => {
  it('只展示确认的四项，Kimi 与智谱均为开放平台 API', () => {
    expect(codexWorkspaceOptions.map(option => [option.id, option.title])).toEqual([
      ['official', 'OpenAI 官方套餐'],
      ['deepseek', 'DeepSeek API'],
      ['moonshot', 'Kimi API'],
      ['zhipu-api', '智谱 API']
    ])
  })

  it('只接受受控结果，成功和错误 Key 文案说明隔离边界', () => {
    const opened = readCodexWorkspaceOpenResult('{"ok":true,"source":"deepseek","code":"opened"}')
    expect(codexWorkspaceResultMessage(opened, 'DeepSeek API')).toContain('工具箱现在可以退出')
    const rejected = readCodexWorkspaceOpenResult('{"ok":false,"source":"deepseek","code":"key_rejected"}')
    expect(codexWorkspaceResultMessage(rejected, 'DeepSeek API')).toContain('原有官方登录、Key 和窗口均未改动')
    expect(readCodexWorkspaceOpenResult('{"ok":true,"source":"other","code":"opened"}')).toBeNull()
  })
})
