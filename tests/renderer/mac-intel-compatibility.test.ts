import { describe, expect, it } from 'vitest'
import { isIntelMac, macIntelCompatibility } from '../../app/renderer/src/platform/mac-intel-compatibility'

describe('Intel Mac 上的 AI 官方支持提示', () => {
  it('只将官方明确不支持 Intel 的 AI 标为不支持', () => {
    expect(macIntelCompatibility('codex')).toMatchObject({ status: 'unsupported' })
    expect(macIntelCompatibility('hermes')).toMatchObject({ status: 'unsupported' })
    expect(macIntelCompatibility('claude-code')).toEqual({ status: 'supported' })
    expect(macIntelCompatibility('zcode')).toEqual({ status: 'supported' })
    expect(macIntelCompatibility('kimi-code')).toEqual({ status: 'supported' })
  })

  it('官方未明确的 AI 如实显示待确认，不冒充不支持或已支持', () => {
    expect(macIntelCompatibility('deepseek-harness')).toMatchObject({ status: 'unknown' })
  })

  it('只在 Intel macOS 运行时显示该提示', () => {
    expect(isIntelMac('darwin', 'x64')).toBe(true)
    expect(isIntelMac('darwin', 'arm64')).toBe(false)
    expect(isIntelMac('win32', 'x64')).toBe(false)
  })
})
