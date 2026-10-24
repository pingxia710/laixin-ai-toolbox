import { describe, expect, it, vi } from 'vitest'
import { AUTO_UPDATE_CHECK_INTERVAL_MS, AUTO_UPDATE_DOWNLOAD_ATTEMPTS, AUTO_UPDATE_RETRY_INTERVAL_MS, AutoUpdateCoordinator, updateNotificationKey } from '../../app/main/desktop/auto-update'
import { DesktopStore } from '../../app/main/desktop/preferences'
import type { UpdateView } from '../../app/desktop-types'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const view = (state: UpdateView['state'], version = '0.4.1-unified.20'): UpdateView => ({ state, version: state === 'current' ? '' : version, notes: '', progress: 0, message: '' })

function harness(options: { auto?: boolean; check?: UpdateView['state'][]; download?: UpdateView['state'][] } = {}) {
  let now = 1_800_000_000_000
  let current = view('idle')
  const checks = [...(options.check ?? ['available'])], downloads = [...(options.download ?? ['ready'])]
  const driver = {
    status: () => current,
    check: vi.fn(async () => { current = view(checks.length > 1 ? checks.shift()! : checks[0]); return current }),
    download: vi.fn(async () => { current = view(downloads.length > 1 ? downloads.shift()! : downloads[0]); return current })
  }
  const remembered = new Set<string>()
  const memory = { autoUpdate: () => options.auto ?? true, notified: (key: string) => remembered.has(key), remember: (key: string) => { remembered.add(key) } }
  const notify = vi.fn()
  const coordinator = new AutoUpdateCoordinator(driver, memory, { notify, now: () => now })
  return { coordinator, driver, notify, remembered, advance: (ms: number) => { now += ms }, set: (value: UpdateView) => { current = value } }
}

describe('自动更新：检查、下载、提醒', () => {
  it('启动后检查到新版就自动下载，下载完成只提醒一次', async () => {
    const h = harness()
    expect(await h.coordinator.run('startup')).toBe('notified')
    expect(h.driver.check).toHaveBeenCalledOnce(); expect(h.driver.download).toHaveBeenCalledOnce()
    expect(h.notify).toHaveBeenCalledWith('0.4.1-unified.20')
    expect(await h.coordinator.run('interval')).toBe('skipped')
    expect(h.notify).toHaveBeenCalledOnce()
  })

  it('已是最新版时 6 小时内不再检查；到期后再检查', async () => {
    const h = harness({ check: ['current'] })
    expect(await h.coordinator.run('startup')).toBe('current')
    h.set(view('current'))
    expect(await h.coordinator.run('interval')).toBe('skipped')
    h.advance(AUTO_UPDATE_CHECK_INTERVAL_MS)
    expect(await h.coordinator.run('interval')).toBe('current')
    expect(h.driver.check).toHaveBeenCalledTimes(2)
  })

  it('检查失败 30 分钟后重试，不提醒错误', async () => {
    const h = harness({ check: ['error', 'available'] })
    expect(await h.coordinator.run('startup')).toBe('failed')
    h.set(view('error'))
    h.advance(AUTO_UPDATE_RETRY_INTERVAL_MS - 1)
    expect(await h.coordinator.run('interval')).toBe('skipped')
    h.advance(1)
    expect(await h.coordinator.run('interval')).toBe('notified')
    expect(h.notify).toHaveBeenCalledOnce()
  })

  it('下载失败有限重试；同一版本超过上限后不再自动下载，只保留可见的新版状态', async () => {
    const h = harness({ download: ['error'] })
    for (let attempt = 0; attempt < AUTO_UPDATE_DOWNLOAD_ATTEMPTS; attempt++) {
      h.set(view('available'))
      expect(await h.coordinator.run('manual')).toBe('failed')
    }
    h.set(view('available'))
    expect(await h.coordinator.run('manual')).toBe('available')
    expect(h.driver.download).toHaveBeenCalledTimes(AUTO_UPDATE_DOWNLOAD_ATTEMPTS)
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('关闭自动更新时只检查不下载、不弹提醒；重新开启后手动触发立即下载', async () => {
    let auto = false
    const h = harness()
    const coordinator = new AutoUpdateCoordinator(h.driver, { autoUpdate: () => auto, notified: () => false, remember: () => undefined }, { notify: h.notify })
    expect(await coordinator.run('startup')).toBe('disabled')
    expect(h.driver.download).not.toHaveBeenCalled()
    auto = true
    expect(await coordinator.run('manual')).toBe('notified')
  })

  it('下载或安装进行中不重复触发；已备好的新版启动时补一次提醒', async () => {
    const h = harness()
    h.set(view('downloading'))
    expect(await h.coordinator.run('interval')).toBe('skipped')
    h.set(view('ready'))
    expect(await h.coordinator.run('startup')).toBe('notified')
    expect(h.driver.check).not.toHaveBeenCalled()
  })

  it('提醒记录持久化：重启后同一版本不再弹，新版本会弹', async () => {
    const root = await mkdtemp(join(tmpdir(), 'toolbox-auto-update-'))
    try {
      const store = new DesktopStore(join(root, 'desktop.json'))
      expect(store.preferences().autoUpdate).toBe(true)
      store.rememberNotification(updateNotificationKey('0.4.1-unified.20'))
      store.save({ autoUpdate: false })
      const reopened = new DesktopStore(join(root, 'desktop.json'))
      expect(reopened.preferences().autoUpdate).toBe(false)
      expect(reopened.notified(updateNotificationKey('0.4.1-unified.20'))).toBe(true)
      expect(reopened.notified(updateNotificationKey('0.4.1-unified.21'))).toBe(false)
      expect(JSON.parse(await readFile(join(root, 'desktop.json'), 'utf8')).autoUpdate).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
