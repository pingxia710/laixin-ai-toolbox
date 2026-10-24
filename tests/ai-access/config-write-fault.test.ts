import { describe, expect, it } from 'vitest'
import { configFaultCore, configWriteFaultNotice } from '../../app/main/ai-access/config-write-fault'

// 目录只读或属主不对时，只回一句 configuration_failed 就是放弃式处理（纪律 2）。
// 这组用例锁定：提示里必须有目录、属主和一句能照做的话；⛔ 有 Key 或错误原文。
describe('配置写入故障提示', () => {
  const statInfo = (uid?: number, isDirectory = false) => ({ uid, isDirectory: () => isDirectory })
  const denied = (path: string): Error => new Error('AI_ACCESS_CONFIG_FILE_INVALID', {
    cause: Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES', path })
  })

  it('从 cause 里剥出 EACCES 和路径，报出目录、属主差和能照做的命令', async () => {
    const notice = await configWriteFaultNotice(denied('/Users/demo/.claude/settings.json'), {
      stat: async () => statInfo(0), currentUid: 501
    })
    expect(notice).toContain('/Users/demo/.claude')
    expect(notice).toContain('uid 0')
    expect(notice).toContain('uid 501')
    expect(notice).toContain('chown')
    expect(notice).toContain('不会自动改属主')
  })

  it('错误里的 path 是临时文件时说配置目录，不让客户去找 .laixin-*.tmp', async () => {
    const notice = await configWriteFaultNotice(
      new Error('AI_ACCESS_CONFIG_FILE_INVALID', {
        cause: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', path: '/Users/demo/.claude/.laixin-ai-access-abc.tmp' })
      }),
      { stat: async () => statInfo(501), currentUid: 501 }
    )
    expect(notice).toContain('/Users/demo/.claude')
    expect(notice).not.toContain('.laixin-ai-access')
    expect(notice).toContain('属主是当前用户')
  })

  it('文件不存在时退而 stat 它的目录，属主照样说得出来', async () => {
    const notice = await configWriteFaultNotice(denied('/Users/demo/.claude/settings.json'), {
      stat: async (path) => path === '/Users/demo/.claude' ? statInfo(0) : undefined, currentUid: 501
    })
    expect(notice).toContain('/Users/demo/.claude')
    expect(notice).toContain('uid 0')
  })

  it('Windows 没有属主概念：说只读属性和安全权限，不提 chown', async () => {
    const notice = await configWriteFaultNotice(
      Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM', path: 'C:\\Users\\demo\\.codex\\config.toml' }),
      { stat: async () => undefined, currentUid: undefined, platform: 'win32' }
    )
    expect(notice).toContain('.codex')
    expect(notice).toContain('只读属性')
    expect(notice).not.toContain('chown')
  })

  it('只读卷、磁盘满、认不出的故障各给对应的下一步，而不是一句「失败」', async () => {
    const readOnly = Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS', path: '/Volumes/ro/settings.json' })
    expect(await configWriteFaultNotice(readOnly, { stat: async () => statInfo(501), currentUid: 501 })).toContain('只读')
    const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC', path: '/Users/demo/.hermes/.env' })
    expect(await configWriteFaultNotice(full, { stat: async () => statInfo(501), currentUid: 501 })).toContain('磁盘')
    const ioError = Object.assign(new Error('EIO: i/o error'), { code: 'EIO', path: '/Users/demo/.claude/settings.json' })
    expect(await configWriteFaultNotice(ioError, { stat: async () => statInfo(501), currentUid: 501 })).toContain('请检查')
  })

  it('跟写入故障无关的错误（无 code 无 path）不给提示，⛔ 编一句误导', async () => {
    expect(await configWriteFaultNotice(new Error('AI_ACCESS_PROVIDER_UNSUPPORTED'))).toBeUndefined()
    expect(configFaultCore(new Error('plain'))).toEqual({})
  })

  it('⛔ 把错误原文或疑似密钥的内容带进提示', async () => {
    const notice = await configWriteFaultNotice(denied('/Users/demo/.claude/settings.json'), {
      stat: async () => statInfo(501), currentUid: 501
    })
    expect(notice).not.toContain('permission denied, open')
    expect(notice).not.toContain('sk-')
  })
})
