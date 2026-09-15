import type { AccountView } from '../../account-types'
import { requestTabNavigation } from './navigation'
import type { TabId } from './tabs'

let current: AccountView = { state: 'unavailable', account: null, overview: null, code: '', message: '正在读取账号状态…' }
const listeners = new Set<(view: AccountView) => void>()
let pendingWrite: Promise<AccountView> | undefined
let pendingRefresh: Promise<AccountView> | undefined
let revision = 0
let returnTab: TabId | undefined
let entryMode: 'login' | 'register' = 'login'
export function takeAccountEntryMode(): 'login' | 'register' { const mode = entryMode; entryMode = 'login'; return mode }
let selectedPlan: string | undefined
export function selectedNetworkPlan(): string | undefined { return selectedPlan }
export function accountSnapshot(): AccountView { return current }
export function onAccountChange(listener: (view: AccountView) => void): () => void {
  listeners.add(listener); listener(current); return () => { listeners.delete(listener) }
}
export function requireAccount(from: TabId, planId?: string, mode: 'login' | 'register' = 'login'): void { returnTab = from; selectedPlan = planId; entryMode = mode; requestTabNavigation('account') }
export function finishAccountNavigation(): void {
  if (returnTab) { const tab = returnTab; returnTab = undefined; requestTabNavigation(tab) }
}
export function cancelAccountNavigation(): void {
  const tab = returnTab ?? 'dashboard'; returnTab = undefined; requestTabNavigation(tab)
}
async function readAccount(action: () => Promise<{ snapshot: string }>, notifyUnchanged: boolean, expectedRevision: number): Promise<AccountView> {
  const previous = JSON.stringify(current)
  let result: AccountView
  try {
    const response = await action()
    const next = JSON.parse(response.snapshot) as AccountView
    if (!next || !['signed-out', 'signed-in', 'unavailable'].includes(next.state)) throw new Error('ACCOUNT_VIEW_INVALID')
    result = next
  } catch {
    result = { state: 'unavailable', account: null, overview: null, code: 'ACCOUNT_SERVICE_UNAVAILABLE', message: '暂时无法读取账号状态，请稍后重试。' }
  }
  if (revision === expectedRevision) current = result
  if (revision === expectedRevision && (notifyUnchanged || JSON.stringify(current) !== previous)) for (const listener of listeners) listener(current)
  return result
}

export function accountAction(action: () => Promise<{ snapshot: string }>, notifyUnchanged = true): Promise<AccountView> {
  const expectedRevision = ++revision
  pendingRefresh = undefined
  // Writes remain ordered; the main process can cancel a background read for logout.
  const previous = pendingWrite
  const pending = (previous ? previous.then(() => readAccount(action, notifyUnchanged, expectedRevision))
    : readAccount(action, notifyUnchanged, expectedRevision)).finally(() => { if (pendingWrite === pending) pendingWrite = undefined })
  pendingWrite = pending
  return pending
}

export function refreshAccount(): Promise<AccountView> {
  if (pendingRefresh) return pendingRefresh
  const expectedRevision = revision
  const refresh = () => revision === expectedRevision
    ? readAccount(() => window.toolbox.account.status(), false, expectedRevision).then(() => current) : Promise.resolve(current)
  const pending = (pendingWrite ? pendingWrite.then(refresh) : refresh()).finally(() => { if (pendingRefresh === pending) pendingRefresh = undefined })
  pendingRefresh = pending
  return pending
}

export function startAccountRefreshLoop(): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = async () => {
    await refreshAccount()
    if (!stopped) timer = setTimeout(() => { void refresh() }, 60_000 + Math.floor(Math.random() * 15_000))
  }
  void refresh()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
