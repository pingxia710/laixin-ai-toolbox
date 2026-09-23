import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const modelApiPage = readFileSync(new URL('../../app/renderer/src/platform/model-api.ts', import.meta.url), 'utf8')

describe('「添加/更换API key」快捷表单换 Key 不重置模型、不提前落盘（API-06）', () => {
  it('表单只发起主进程的原子动作 useProviderWithKey，⛔ 拆成先存 Key 再启用的两步 IPC', () => {
    // 反向变异锚点：恢复「先 saveProviderKey 落盘、再 useProvider 启用」的两步流程必须让这条红——
    // 该流程在验证失败后会把新 Key 留在本地，破坏旧流程「验证失败不落盘」的承诺。
    expect(modelApiPage).toContain('api.useProviderWithKey(')
    expect(modelApiPage).not.toContain('api.saveProviderKey(')
    expect(modelApiPage).not.toMatch(/void switchProvider\(provider,\s*key\)/)
  })

  it('成功文案如实说明模型保持不变，⛔ 只说「配置已写入」让客户以为什么都没变', () => {
    expect(modelApiPage).toContain('模型选择保持不变')
  })
})
