import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { macUsageReceiptSupported, readUsageReceiptResult, readUsageReceiptSaveResult,
  usageReceiptEmptyNotice, usageReceiptSaveNotice, usageReceiptSectionHint } from '../../app/renderer/src/platform/usage-receipt-view'

const modelApiPage = readFileSync(new URL('../../app/renderer/src/platform/model-api.ts', import.meta.url), 'utf8')

describe('模型 API 页的 Mac 使用回执（API-04）', () => {
  it('页面有「生成 Mac 使用回执」手动入口，先预览后才可复制或保存', () => {
    expect(modelApiPage).toContain('生成 Mac 使用回执')
    expect(modelApiPage).toContain('requestUsageReceipt(')
    expect(modelApiPage).toContain('requestUsageReceiptSave(')
    expect(modelApiPage).toContain('usageReceiptSection')
  })

  it('只有 macOS 提供这个入口', () => {
    expect(macUsageReceiptSupported('darwin')).toBe(true)
    expect(macUsageReceiptSupported('win32')).toBe(false)
    expect(macUsageReceiptSupported('linux')).toBe(false)
  })

  it('生成结果三种结局各说各的话：没有记录就如实说，不假装有回执', () => {
    expect(readUsageReceiptResult(JSON.stringify({ ok: true, count: 2, receipt: '回执正文' })))
      .toEqual({ ok: true, count: 2, receipt: '回执正文' })
    expect(readUsageReceiptResult(JSON.stringify({ ok: false, reason: 'empty' })))
      .toEqual({ ok: false, reason: 'empty' })
    expect(readUsageReceiptResult('不是 JSON')).toEqual({ ok: false, reason: 'empty' })
    expect(usageReceiptEmptyNotice({ ok: false, reason: 'empty' })).toContain('还没有可导出的使用记录')
    expect(usageReceiptSectionHint()).toContain('自行')
    expect(usageReceiptSectionHint()).toContain('不会自动发送')
  })

  it('保存结果分清已保存、已取消、过期与未预览；取消要说没写文件，保存不说「已发送」', () => {
    expect(readUsageReceiptSaveResult(JSON.stringify({ ok: true }))).toEqual({ ok: true })
    expect(readUsageReceiptSaveResult(JSON.stringify({ ok: false, reason: 'canceled' }))).toEqual({ ok: false, reason: 'canceled' })
    expect(readUsageReceiptSaveResult('坏数据')).toEqual({ ok: false, reason: 'canceled' })
    expect(usageReceiptSaveNotice({ ok: true })).toContain('自行发送')
    expect(usageReceiptSaveNotice({ ok: true })).not.toContain('已发送给客服')
    expect(usageReceiptSaveNotice({ ok: false, reason: 'canceled' })).toContain('未写入任何文件')
    expect(usageReceiptSaveNotice({ ok: false, reason: 'write-failed' })).toContain('没有完成')
    expect(usageReceiptSaveNotice({ ok: false, reason: 'expired' })).toContain('重新生成')
    expect(usageReceiptSaveNotice({ ok: false, reason: 'no-preview' })).toContain('先')
    expect(usageReceiptSaveNotice({ ok: false, reason: 'no-preview' })).toContain('预览')
  })

  it('平台门在确认 macOS 前不渲染入口：页面不得出现「先挂出再移除」的补救模式', () => {
    // 反向变异锚点：恢复「先渲染再移除入口」的旧实现必须让这条红。
    expect(modelApiPage).not.toContain('section.remove()')
    // 预览快照标识跟随预览产生，保存时只回传标识，⛔ 把回执文本交回渲染层。
    expect(modelApiPage).toContain('snapshotId')
  })
})
