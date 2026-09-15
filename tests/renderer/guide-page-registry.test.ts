import { expect, it } from 'vitest'
import { pageRegistry } from '../../app/renderer/src/page-registry'

it('真实页面注册表不再注册退役安装页', () => {
  expect(pageRegistry.tabIds).not.toContain('install')
  expect(pageRegistry.modulesFor('account').length).toBeGreaterThan(0)
})
