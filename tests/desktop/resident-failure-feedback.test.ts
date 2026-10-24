import { afterEach, expect, it, vi } from 'vitest'
import type { ResidentRuntime } from '../../app/main/tunnel/resident-bridge'

vi.mock('electron', () => ({ app: { isPackaged: true }, dialog: {}, Menu: {}, nativeImage: {}, Notification: class {}, powerMonitor: {}, screen: {}, shell: {}, Tray: class {} }))
import { DesktopRuntime } from '../../app/main/desktop/runtime'
import { calibrateResident, residentCalibrationError, resetResidentRuntime, setResidentRuntime } from '../../app/main/tunnel/resident-owner'

afterEach(resetResidentRuntime)
const register = (calibrate: ResidentRuntime['calibrate']) => setResidentRuntime({ calibrate } as ResidentRuntime)

it('常驻注册拒绝只回传安全码，成功或关闭后清除', async () => {
  const calibrate = vi.fn<ResidentRuntime['calibrate']>().mockResolvedValue({ installed: false, reason: 'private path secret 0x80070005' })
  register(calibrate)
  expect(residentCalibrationError()).toBe('')
  await calibrateResident(true)
  expect(residentCalibrationError()).toBe('0x80070005')
  calibrate.mockResolvedValue({ installed: true }); await calibrateResident(true)
  expect(residentCalibrationError()).toBe('')
  calibrate.mockResolvedValue({ installed: false, reason: 'do not expose raw command' }); await calibrateResident(true)
  expect(residentCalibrationError()).toBe('RESIDENT_SETUP_FAILED')
  await calibrateResident(false)
  expect(residentCalibrationError()).toBe('')
})

it('运行时晚注册和校准抛错也留下失败码，不漏掉开机失败', async () => {
  await calibrateResident(true)
  register(async () => { throw new Error('credential must not appear') })
  await vi.waitFor(() => expect(residentCalibrationError()).toBe('RESIDENT_SETUP_FAILED'))
})

it('关闭低额度通知仍显示常驻失败，关闭常驻选择后不继续报警', async () => {
  register(async () => ({ installed: false, reason: 'HRESULT 0x80070005' }))
  await calibrateResident(true)
  let enabled = true
  const runtime = Object.create(DesktopRuntime.prototype) as DesktopRuntime
  Reflect.set(runtime, 'readAlerts', async () => undefined)
  Reflect.set(runtime, 'store', { preferences: () => ({ quotaNotifications: false }), residentChoice: () => enabled })
  Reflect.set(runtime, 'updater', { status: () => ({ state: 'idle' }) })
  Reflect.set(runtime, 'alerts', [{ id: 'quota', kind: 'network', message: 'low quota' }])
  const status = await runtime.status()
  expect(status.alerts).toHaveLength(1)
  expect(status.alerts[0]).toMatchObject({ kind: 'resident' })
  expect(status.alerts[0].message).toContain('0x80070005')
  expect(status.alerts[0].message).toContain('常驻未生效')
  enabled = false
  expect((await runtime.status()).alerts).toEqual([])
})
