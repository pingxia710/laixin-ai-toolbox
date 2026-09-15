import { describe, expect, it } from 'vitest'
import { collectPreloadApis } from '../app/preload/index'

describe('preload API 收集', () => {
  it('收集显式命名空间并拒绝重复', () => {
    expect(
      collectPreloadApis({
        './api/app.ts': { namespace: 'app', api: { info: () => Promise.resolve() } }
      })
    ).toHaveProperty('app')
    expect(() =>
      collectPreloadApis({
        './api/a.ts': { namespace: 'app', api: {} },
        './api/b.ts': { namespace: 'app', api: {} }
      })
    ).toThrow('PRELOAD_NAMESPACE_DUPLICATE')
  })
})
