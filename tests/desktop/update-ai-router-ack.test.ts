import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electron = vi.hoisted(() => ({ quit: vi.fn(), version: '0.5.20', userData: '/fixture/user-data' }))
const router = vi.hoisted(() => ({ restore: vi.fn() }))
const aiRecovery = vi.hoisted(() => ({ accept: vi.fn(async () => undefined) }))

vi.mock('electron', () => ({
  app: {
    getVersion: () => electron.version,
    getPath: (name: string) => name === 'userData' ? electron.userData : '/fixture/home',
    quit: electron.quit,
    isPackaged: true
  },
  dialog: {}, Menu: {}, nativeImage: {}, Notification: class {}, powerMonitor: {}, screen: {}, shell: {}, Tray: class {}
}))
vi.mock('../../app/main/ai-access/router-upgrade-handoff', () => ({
  prepareAiRouterUpdate: vi.fn(),
  restoreAiRouterAfterUpdate: router.restore
}))
vi.mock('../../app/main/actions/ai-access', () => ({ acceptVerifiedProductionAiRouterRecovery: aiRecovery.accept }))
vi.mock('../../app/main/shells/context', () => ({ recipeStore: () => ({ load: async () => undefined }) }))

import { DesktopRuntime } from '../../app/main/desktop/runtime'
import { acknowledgeUpdate, type AcknowledgeDeps } from '../../app/main/desktop/updater'

let directory = ''

async function pending(): Promise<void> {
  directory = await mkdtemp(join(tmpdir(), 'laixin-update-ai-router-'))
  await writeFile(join(directory, 'pending.json'), JSON.stringify({ version: electron.version, previous: '0.5.19', notes: 'fixture' }))
}

async function acknowledgementExists(): Promise<boolean> {
  try { await access(join(directory, 'acknowledgement.json')); return true } catch { return false }
}

afterEach(async () => {
  electron.quit.mockReset()
  router.restore.mockReset()
  aiRecovery.accept.mockClear()
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = ''
})

describe('更新启动回执等待 AI router 恢复', () => {
  it('多模型路由延迟成功时，回执只能在 router HMAC/runtime/seat 证明后出现', async () => {
    await pending()
    let release: (outcome: 'ready') => void = () => undefined
    const proof = new Promise<'ready'>(resolve => { release = resolve })
    const deps = {
      outcome: () => 'connected' as const,
      giveUp: vi.fn(),
      routerOutcome: async () => await proof
    } as unknown as AcknowledgeDeps

    const acknowledged = acknowledgeUpdate(directory, electron.version, deps)
    await new Promise(resolve => setImmediate(resolve))
    expect(await acknowledgementExists()).toBe(false)

    release('ready')
    await expect(acknowledged).resolves.toMatchObject({ previous: '0.5.19' })
    await expect(readFile(join(directory, 'acknowledgement.json'), 'utf8')).resolves.toContain(electron.version)
  })

  it('router 恢复失败时零回执、写回退拒绝记录并退出新版', async () => {
    await pending()
    const giveUp = vi.fn()
    const deps = {
      outcome: () => 'connected' as const,
      giveUp,
      routerOutcome: () => 'failed'
    } as unknown as AcknowledgeDeps

    await expect(acknowledgeUpdate(directory, electron.version, deps)).resolves.toBeUndefined()

    expect(await acknowledgementExists()).toBe(false)
    expect(giveUp).toHaveBeenCalledTimes(1)
    await expect(readFile(join(directory, 'rejected.json'), 'utf8')).resolves.toContain(electron.version)
  })

  it('单模型/未配置路由不额外等待', async () => {
    await pending()
    const wait = vi.fn(async () => undefined)
    const deps = {
      outcome: () => 'connected' as const,
      giveUp: vi.fn(),
      wait,
      routerOutcome: () => 'not_configured'
    } as unknown as AcknowledgeDeps

    await expect(acknowledgeUpdate(directory, electron.version, deps)).resolves.toMatchObject({ previous: '0.5.19' })

    expect(wait).not.toHaveBeenCalled()
    expect(await acknowledgementExists()).toBe(true)
  })

  it('DesktopRuntime.ready 的生产启动接线也在证明前阻止回执，失败时交给更新助手回退', async () => {
    await pending()
    let release: (outcome: 'ready' | 'failed') => void = () => undefined
    const proof = new Promise<'ready' | 'failed'>(resolve => { release = resolve })
    router.restore.mockImplementation(async () => await proof)
    const runtime = Object.create(DesktopRuntime.prototype) as DesktopRuntime
    Reflect.set(runtime, 'updateDirectory', directory)
    Reflect.set(runtime, 'quitting', false)

    await runtime.ready()
    await vi.waitFor(() => expect(router.restore).toHaveBeenCalledTimes(1))
    expect(await acknowledgementExists()).toBe(false)

    release('failed')
    await vi.waitFor(() => expect(electron.quit).toHaveBeenCalledTimes(1))
    expect(await acknowledgementExists()).toBe(false)
    await expect(readFile(join(directory, 'rejected.json'), 'utf8')).resolves.toContain(electron.version)
    expect(aiRecovery.accept).not.toHaveBeenCalled()
  })

  it('DesktopRuntime.ready 只在已证明的新 router 成功后清除旧 local_service_down', async () => {
    await pending()
    router.restore.mockResolvedValue('ready')
    const runtime = Object.create(DesktopRuntime.prototype) as DesktopRuntime
    Reflect.set(runtime, 'updateDirectory', directory)
    Reflect.set(runtime, 'quitting', false)

    await runtime.ready()
    await vi.waitFor(() => expect(aiRecovery.accept).toHaveBeenCalledTimes(1))

    expect(await acknowledgementExists()).toBe(true)
    expect(router.restore).toHaveBeenCalledTimes(1)
  })
})
