import { describe, expect, it } from 'vitest'
import { resolveRendererTarget } from '../../app/main/bridge/renderer-target'

describe('渲染页入口选择', () => {
  it('打包态忽略开发地址，开发态只接受明确地址', () => {
    expect(resolveRendererTarget(true, 'http://127.0.0.1:5173', '/bundle/index.html')).toEqual({
      kind: 'file',
      value: '/bundle/index.html'
    })
    expect(resolveRendererTarget(false, 'http://127.0.0.1:5173', '/bundle/index.html')).toEqual({
      kind: 'url',
      value: 'http://127.0.0.1:5173'
    })
    expect(() => resolveRendererTarget(false, undefined, '/bundle/index.html')).toThrow(
      '开发模式缺少有效的渲染页面地址。'
    )
    expect(() => resolveRendererTarget(false, 'https://example.com/index.html', '/bundle/index.html')).toThrow(
      '开发模式渲染页面必须是本地 HTTP 入口。'
    )
  })
})
