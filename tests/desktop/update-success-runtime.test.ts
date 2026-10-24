import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {}, dialog: {}, Menu: {}, nativeImage: {}, Notification: class {}, powerMonitor: {}, screen: {}, shell: {}, Tray: class {}
}))

import { DesktopRuntime } from '../../app/main/desktop/runtime'

it('关闭更新成功提示后，同一进程重新拉取也不再弹出', async () => {
  const runtime = Object.create(DesktopRuntime.prototype) as DesktopRuntime
  Reflect.set(runtime, 'successNotice', { version: '0.5.18', previous: '0.5.17', notes: '修复网络' })
  expect(runtime.updateSuccess().version).toBe('0.5.18')
  await runtime.dismissUpdateSuccess('0.5.17')
  expect(runtime.updateSuccess().version).toBe('0.5.18')
  await runtime.dismissUpdateSuccess('0.5.18')
  expect(runtime.updateSuccess().version).toBe('')
})
