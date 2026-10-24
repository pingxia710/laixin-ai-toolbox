import { randomBytes } from 'node:crypto'
import { link, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface AiRouterRuntime { readonly pid: number; readonly bootId: string; readonly port: number; readonly token: string }
export interface AiRouterSeatOwner { readonly pid: number; readonly bootId: string }
export interface AiRouterSeat extends AiRouterSeatOwner { assertOwnership(): Promise<void>; release(): Promise<void> }
export type AiRouterSeatProof = (owner: AiRouterSeatOwner) => Promise<boolean>
const seatName = 'ai-router.seat'
const runtimeName = 'ai-router.runtime.json'
const startupLeaseMs = 8_000

interface AiRouterSeatRecord extends AiRouterSeatOwner { readonly startedAt?: number }
export interface AiRouterSeatSnapshot { readonly raw: Buffer; readonly holder?: AiRouterSeatRecord }

/**
 * A PID is only a short bootstrap lease. Once a router is listening, the caller must prove its
 * bootId over the local HMAC control plane; a PID reused by an unrelated process cannot own this
 * seat forever. The brief lease prevents a second launcher from stealing the first router before
 * it can publish that proof.
 */
export async function acquireAiRouterSeat(root: string, proveOwner: AiRouterSeatProof = async () => false): Promise<AiRouterSeat> {
  const path = join(root, seatName)
  const bootId = randomBytes(16).toString('hex')
  const mine = JSON.stringify({ pid: process.pid, bootId, startedAt: Date.now() })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const file = await open(path, 'wx', 0o600)
      try { await file.writeFile(mine) } finally { await file.close() }
      const ownsSeat = async (): Promise<boolean> => (await readFile(path, 'utf8').catch(() => '')) === mine
      return {
        pid: process.pid,
        bootId,
        assertOwnership: async () => { if (!(await ownsSeat())) throw new Error('AI_ROUTER_SEAT_LOST') },
        release: async () => { if (await ownsSeat()) await rm(path, { force: true }) }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const snapshot = await readAiRouterSeatSnapshot(path)
      if (!snapshot) continue
      const holder = snapshot.holder
      if (holder && await proveOwner(holder).catch(() => false)) throw new Error('AI_ROUTER_SEAT_HELD', { cause: error })
      if (holder && await hasStartupLease(holder)) throw new Error('AI_ROUTER_SEAT_HELD', { cause: error })
      // The HMAC proof is asynchronous. Re-read the exact seat bytes before reclaiming so its
      // result cannot authorize a rename of a newer owner that appeared while the proof ran.
      if (!sameSeatSnapshot(snapshot, await readAiRouterSeatSnapshot(path))) continue
      await quarantineStaleSeat(path, `${path}.stale-${bootId}`, snapshot)
    }
  }
  throw new Error('AI_ROUTER_SEAT_UNAVAILABLE')
}

async function readAiRouterSeatSnapshot(path: string): Promise<AiRouterSeatSnapshot | undefined> {
  let raw: Buffer
  try { raw = await readFile(path) } catch { return undefined }
  let value: unknown
  try { value = JSON.parse(raw.toString('utf8')) } catch { return { raw } }
  if (!value || typeof value !== 'object') return { raw }
  const entry = value as Partial<AiRouterSeatRecord>
  const pid = entry.pid, bootId = entry.bootId, startedAt = entry.startedAt
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof bootId !== 'string' || !/^[a-f0-9]{32}$/.test(bootId)) return { raw }
  return {
    raw,
    holder: typeof startedAt === 'number' && Number.isInteger(startedAt) ? { pid, bootId, startedAt }
      : { pid, bootId }
  }
}

export async function readAiRouterSeat(root: string): Promise<AiRouterSeatSnapshot | undefined> {
  return readAiRouterSeatSnapshot(join(root, seatName))
}

export async function removeAiRouterSeat(root: string, expected: AiRouterSeatSnapshot): Promise<boolean> {
  const path = join(root, seatName)
  if (!sameSeatSnapshot(expected, await readAiRouterSeatSnapshot(path))) return false
  await rm(path, { force: true })
  return true
}

function sameSeatSnapshot(expected: AiRouterSeatSnapshot, actual: AiRouterSeatSnapshot | undefined): boolean {
  return actual !== undefined && expected.raw.equals(actual.raw)
}

async function quarantineStaleSeat(path: string, quarantine: string, snapshot: AiRouterSeatSnapshot): Promise<void> {
  if (!sameSeatSnapshot(snapshot, await readAiRouterSeatSnapshot(path))) return
  try { await rename(path, quarantine) } catch { return }
  if (sameSeatSnapshot(snapshot, await readAiRouterSeatSnapshot(quarantine))) {
    await rm(quarantine, { force: true })
    return
  }
  // A path change raced the final rename. Never delete the unexpected bytes. If the seat path is
  // empty, restore them with a hard link; if another owner already installed a seat, leave both
  // files untouched and fail closed.
  try {
    await link(quarantine, path)
    await rm(quarantine)
  } catch { /* preserving an unexpected owner is safer than replacing it */ }
  throw new Error('AI_ROUTER_SEAT_RACE')
}

async function hasStartupLease(holder: AiRouterSeatRecord): Promise<boolean> {
  if (holder.startedAt === undefined || holder.startedAt > Date.now() || Date.now() - holder.startedAt > startupLeaseMs) return false
  try { process.kill(holder.pid, 0); return true } catch { return false }
}

export async function readAiRouterRuntime(root: string): Promise<AiRouterRuntime | undefined> {
  let value: unknown
  try { value = JSON.parse(await readFile(join(root, runtimeName), 'utf8')) } catch { return undefined }
  if (!value || typeof value !== 'object') return undefined
  const entry = value as Partial<AiRouterRuntime>
  if (!Number.isInteger(entry.pid) || !/^[a-f0-9]{32}$/.test(entry.bootId ?? '') ||
    !Number.isInteger(entry.port) || !/^[a-f0-9]{64}$/.test(entry.token ?? '')) return undefined
  return entry as AiRouterRuntime
}

export async function writeAiRouterRuntime(root: string, runtime: AiRouterRuntime): Promise<void> {
  const path = join(root, runtimeName)
  const temporary = `${path}.${runtime.bootId}.tmp`
  await writeFile(temporary, JSON.stringify(runtime), { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

export async function removeAiRouterRuntime(root: string, bootId: string): Promise<void> {
  const current = await readAiRouterRuntime(root)
  if (current?.bootId === bootId) await rm(join(root, runtimeName), { force: true })
}
