import type { UsageBucket, UsageWindow } from './types'
import { createHash } from 'node:crypto'

export function codexAccountKey(account: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(account)).digest('hex')
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function label(value: unknown, max = 120): string | null {
  return typeof value === 'string' && value.trim() ? [...value].filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').slice(0, max) : null
}

function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function normalizeWindow(value: unknown): UsageWindow | null {
  const data = record(value)
  if (!data) return null
  const percent = nonnegative(data.usedPercent)
  const usedPercent = percent === null ? null : Math.min(100, percent)
  const duration = nonnegative(data.windowDurationMins)
  const reset = nonnegative(data.resetsAt)
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    windowDurationMins: duration !== null && duration > 0 ? duration : null,
    resetsAt: reset !== null && reset > 0 && reset <= 8_640_000_000_000 ? reset : null
  }
}

export function normalizeBuckets(value: unknown): readonly UsageBucket[] {
  const data = record(value)
  if (!data) return []
  const multiple = record(data.rateLimitsByLimitId)
  const entries = multiple && Object.keys(multiple).length > 0
    ? Object.entries(multiple)
    : data.rateLimits ? [['codex', data.rateLimits] as const] : []
  return entries.slice(0, 32).flatMap(([key, value]) => {
    const bucket = record(value)
    if (!bucket) return []
    const credits = record(bucket.credits)
    const balance = label(credits?.balance, 32)
    const id = label(bucket.limitId) ?? key.slice(0, 120)
    return [{
      id,
      name: label(bucket.limitName) ?? (id === 'codex' ? 'Codex' : id),
      primary: normalizeWindow(bucket.primary),
      secondary: normalizeWindow(bucket.secondary),
      credits: credits && typeof credits.unlimited === 'boolean' ? {
        unlimited: credits.unlimited,
        balance: balance && /^\d+(\.\d+)?$/.test(balance) ? balance : null
      } : null
    }]
  })
}

export function maskAccount(email: unknown): string {
  if (typeof email !== 'string') return '当前 ChatGPT 账号'
  const at = email.indexOf('@')
  return at > 0 ? `${email.slice(0, Math.min(at, 2))}***${email.slice(at).slice(0, 80)}` : '当前 ChatGPT 账号'
}
