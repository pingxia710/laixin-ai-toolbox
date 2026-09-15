import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopStore, visibleBounds } from '../../app/main/desktop/preferences'
import { keepWindowInBackground } from '../../app/main/desktop/window-lifecycle'
import { quotaAlerts } from '../../app/main/desktop/alerts'
import { ApplicationLauncher } from '../../app/main/desktop/applications'
import type { UsageReport } from '../../app/main/codex-usage/types'
import type { AccountView } from '../../app/account-types'

const directories: string[] = []
const temporary = async () => { const root = await mkdtemp(join(tmpdir(), 'toolbox-desktop-test-')); directories.push(root); return root }
afterEach(async () => { for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true }) })

it('关窗口只隐藏，明确退出和无托盘时正常关闭', () => {
  let close!: (event: { preventDefault(): void }) => void
  let background = true
  const hide = vi.fn(), save = vi.fn(), preventDefault = vi.fn()
  keepWindowInBackground({ on: (_event, fn) => { close = fn }, hide }, () => background, save)
  close({ preventDefault }); expect(hide).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledOnce()
  background = false; close({ preventDefault })
  expect(hide).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledTimes(2)
})

it('缩放和窗口重启后仍在，断开显示器后不恢复到屏幕外', async () => {
  const root = await temporary(), file = join(root, 'desktop.json')
  const store = new DesktopStore(file)
  store.save({ zoom: 1.25, bounds: { x: 1300, y: 10, width: 1180, height: 820 }, maximized: true })
  store.rememberNotification('period-one')
  const reopened = new DesktopStore(file)
  expect(reopened.preferences().zoom).toBe(1.25); expect(reopened.notified('period-one')).toBe(true)
  expect(reopened.window().maximized).toBe(true)
  expect(visibleBounds(reopened.window().bounds, [{ x: 0, y: 0, width: 1200, height: 800 }])).toBeUndefined()
  expect(visibleBounds({ x: 900, y: 600, width: 1180, height: 820 }, [{ x: 0, y: 0, width: 1200, height: 800 }])).toEqual({ x: 20, y: 0, width: 1180, height: 800 })
  expect(() => store.save({ zoom: 5 })).toThrow('DESKTOP_ZOOM_INVALID')
  expect(JSON.parse(await readFile(file, 'utf8')).zoom).toBe(1.25)
})

const now = 1_800_000_000_000
const ai = (remaining = 8, reset = now / 1000 + 3600): UsageReport => ({ status: 'ready', checkedAt: now, nextRefreshAt: null,
  snapshot: { accountKey: 'account-one', accountLabel: 'fixture', plan: 'plus', fetchedAt: now, buckets: [{ id: 'codex', name: 'Codex', credits: null,
    primary: { remainingPercent: remaining, usedPercent: 100 - remaining, windowDurationMins: 300, resetsAt: reset }, secondary: null }] } })
const network = (remaining = 5): AccountView => ({ state: 'signed-in', account: { id: 'fixture', username: 'fixture' }, message: '', code: '',
  overview: { recoveryReady: true, networkAvailable: true, paymentChannels: [], plans: [], subscription: null,
    trial: { available: false, usage: { authorizationId: 'fixture-allocation', kind: 'trial', planId: 'trial', state: 'active', measurement: 'current',
      totalBytes: 100, usedBytes: 100 - remaining, remainingBytes: remaining, expiresAt: now + 3600_000, observedAt: now, reasonCode: '' } } } })

describe('低额度只基于当前真实读数，按账号周期去重', () => {
  it('AI 与网络分别提醒，同周期保持同一个标识，下一周期和账号可以重新提醒', () => {
    const alerts = quotaAlerts(ai(), network(), now)
    expect(alerts.map((a) => a.kind)).toEqual(['ai', 'network'])
    expect(quotaAlerts(ai(0), network(0), now).map((a) => a.id)).toEqual(alerts.map((a) => a.id))
    expect(quotaAlerts(ai(8, now / 1000 + 7200), undefined, now)[0].id).not.toBe(alerts[0].id)
    const changed = { ...ai(), snapshot: { ...ai().snapshot!, accountKey: 'account-two' } }
    expect(quotaAlerts(changed, undefined, now)[0].id).not.toBe(alerts[0].id)
  })
  it('失败、过期、未知不会变成零，也不沿用旧账号', () => {
    expect(quotaAlerts({ ...ai(), status: 'unavailable' }, undefined, now)).toEqual([])
    expect(quotaAlerts(ai(), network(), now + 11 * 60_000)).toEqual([])
    const missing = network(); missing.overview!.trial.usage!.measurement = 'unavailable'
    expect(quotaAlerts(undefined, missing, now)).toEqual([])
    expect(quotaAlerts(undefined, { ...network(), state: 'signed-out' }, now)).toEqual([])
    expect(quotaAlerts(ai(11), network(11), now)).toEqual([])
  })
  it('有效付费流量一起计算，未付款申请不会挡住体验流量提醒', () => {
    const value = network()
    value.overview!.subscription = { ...value.overview!.trial.usage!, authorizationId: 'paid', kind: 'subscription', remainingBytes: 90 }
    expect(quotaAlerts(undefined, value, now)).toEqual([])
    value.overview!.subscription = { ...value.overview!.subscription, state: 'pending', measurement: 'not-requested', remainingBytes: null }
    expect(quotaAlerts(undefined, value, now)).toHaveLength(1)
  })
})

it('Windows Codex 只打开已安装官方包中的应用 ID；输入不能执行任意程序', async () => {
  const read = vi.fn(async () => JSON.stringify({ Family: 'OpenAI.Codex_2p2nqsd0c76g0', AppId: 'App', Version: '26.9' }))
  const dispatch = vi.fn(async () => undefined)
  const launcher = new ApplicationLauncher(await temporary(), 'win32', vi.fn(), read, dispatch)
  expect((await launcher.list())[0]).toMatchObject({ id: 'codex', state: 'installed' })
  expect((await launcher.open('codex')).opened).toBe(true)
  expect(dispatch).toHaveBeenCalledWith('explorer.exe', ['shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'])
  await expect(launcher.open('codex;calc.exe')).rejects.toThrow('AI_APPLICATION_INVALID')
  read.mockResolvedValue(JSON.stringify({ Family: 'Unexpected.Product_2p2nqsd0c76g0', AppId: 'App', Version: '26.9' }))
  expect((await launcher.open('codex')).opened).toBe(false)
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('Hermes 安装器不等于已安装的桌面软件，打开失败会传回界面', async () => {
  const home = await temporary(), bundle = join(home, '.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app/Contents')
  await mkdir(join(bundle, 'MacOS'), { recursive: true }); await writeFile(join(bundle, 'Info.plist'), 'fixture')
  const read = vi.fn(async (_command: string, args: string[]): Promise<string> => args[1].includes('Executable') ? 'Hermes-Setup' : 'Hermes')
  const open = vi.fn(async () => 'not launchable')
  const launcher = new ApplicationLauncher(home, 'darwin', open, read)
  expect((await launcher.open('hermes')).opened).toBe(false); expect(open).not.toHaveBeenCalled()
  read.mockImplementation(async (_command, args) => args[1].includes('Executable') ? 'Hermes' : '1.0')
  await writeFile(join(bundle, 'MacOS/Hermes'), 'fixture', { mode: 0o755 })
  expect((await launcher.list())[1].state).toBe('installed')
  expect((await launcher.open('hermes')).opened).toBe(false)
  expect(open).toHaveBeenCalledWith(join(bundle, '..'))
})
