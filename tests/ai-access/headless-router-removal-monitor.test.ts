import { afterEach, describe, expect, it, vi } from 'vitest'
import { startExecutableRemovalMonitor } from '../../app/main/ai-access/headless-router'

afterEach(() => { vi.useRealTimers() })

describe('macOS 拖拽删除后 headless 自清理', () => {
  it('连续两次确认可执行文件不存在后才收尾', async () => {
    vi.useFakeTimers()
    const removed = vi.fn(async () => undefined)
    const stat = vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) })
    const stop = startExecutableRemovalMonitor('/Applications/Laixin.app/Contents/MacOS/Laixin', removed, { intervalMs: 10, stat: stat as never })

    await vi.advanceTimersByTimeAsync(10)
    expect(removed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    expect(removed).toHaveBeenCalledTimes(1)
    stop()
  })
})
