import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView } from '../../app/account-types'

const signedIn: AccountView = { state: 'signed-in', account: { id: 'acct_' + 'a'.repeat(32), username: 'local' }, overview: null, code: '', message: '' }
const signedOut: AccountView = { state: 'signed-out', account: null, overview: null, code: '', message: '' }
const response = (view: AccountView) => ({ snapshot: JSON.stringify(view) })
function deferred() {
  let resolve!: (value: { snapshot: string }) => void
  const promise = new Promise<{ snapshot: string }>((done) => { resolve = done })
  return { promise, resolve }
}
async function setup(status = vi.fn(async () => response(signedIn))) {
  vi.resetModules()
  vi.stubGlobal('window', { toolbox: { account: { status } } })
  return { ...await import('../../app/renderer/src/account-state'), status }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('renderer refresh requests share the pending result without caching a later refresh', async () => {
  const f = await setup()
  const first = f.refreshAccount(); const second = f.refreshAccount()
  expect(first).toBe(second)
  await first
  expect(f.status).toHaveBeenCalledTimes(1)
  await f.refreshAccount()
  expect(f.status).toHaveBeenCalledTimes(2)
})

it('logout is sent while a refresh is pending and the late refresh cannot replace the signed-out view', async () => {
  const read = deferred(); const status = vi.fn(() => read.promise)
  const f = await setup(status)
  const pending = f.refreshAccount()
  const logout = vi.fn(async () => response(signedOut))
  expect((await f.accountAction(logout)).state).toBe('signed-out')
  expect(logout).toHaveBeenCalledTimes(1)
  read.resolve(response(signedIn)); await pending
  expect(f.accountSnapshot().state).toBe('signed-out')
})

it('writes remain ordered and a shared refresh waits for the last write', async () => {
  const f = await setup(); const first = deferred(); const second = deferred()
  const writeA = vi.fn(() => first.promise); const writeB = vi.fn(() => second.promise)
  const a = f.accountAction(writeA); const b = f.accountAction(writeB)
  const refresh = f.refreshAccount()
  expect(f.refreshAccount()).toBe(refresh)
  expect(writeA).toHaveBeenCalledTimes(1); expect(writeB).not.toHaveBeenCalled(); expect(f.status).not.toHaveBeenCalled()
  first.resolve(response(signedIn)); expect((await a).state).toBe('signed-in')
  expect(writeB).toHaveBeenCalledTimes(1); expect(f.status).not.toHaveBeenCalled()
  second.resolve(response(signedOut)); await b; await refresh
  expect(f.status).toHaveBeenCalledTimes(1)
})

it('the refresh loop waits 60–75 seconds after completion and stopping it cannot be undone by a pending read', async () => {
  vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5)
  const f = await setup(); const stop = f.startAccountRefreshLoop()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.status).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(67_499)
  expect(f.status).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.status).toHaveBeenCalledTimes(2)
  const pending = deferred(); f.status.mockImplementation(() => pending.promise)
  await vi.advanceTimersByTimeAsync(67_500)
  expect(f.status).toHaveBeenCalledTimes(3)
  stop(); pending.resolve(response(signedIn)); await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(f.status).toHaveBeenCalledTimes(3)
})
