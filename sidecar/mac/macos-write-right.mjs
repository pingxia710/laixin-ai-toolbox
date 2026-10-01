// macOS 同一用户的系统代理全局写权。
//
// Windows 用内核命名互斥体；macOS 没有可由纯 Node 长期持有、且随进程死亡自动释放的同类原语。
// 这里用用户私有目录中的原子硬链接作为席位，并用随包 flock 启动器串行化席位切换：
//   · 创建、stale 回收与释放共享同一 flock 临界区，席位里的 PID/出生标识/随机令牌作 CAS；
//   · 活持有者永不按时间抢占，timeoutMs 只表示等待多久；
//   · 进程死亡或 PID 已被复用时才回收；移除旧席位前先持久化恢复责任，账本还原后才清除；
//   · 锁、恢复标记和父目录均为当前用户私有，拒绝符号链接/异常类型，删除时同时核对 inode 与随机令牌。
import {
  chmodSync, closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWNER_VERSION = 1
const MAX_OWNER_BYTES = 8_192
const POLL_MS = 50
const PRIVATE_MASK = 0o077
const TRANSITION_MODE = '--macos-write-right-transition'
const WRITE_LOCK = fileURLToPath(new URL('./bin/write-lock', import.meta.url))

export function writeRightPath(home = homedir()) {
  return join(home, 'Library', 'Application Support', 'Laixin', 'system-proxy-write-right.json')
}

function dataDirFromArgv(argv = process.argv) {
  const index = argv.indexOf('--data-dir')
  const value = index >= 0 ? argv[index + 1] : undefined
  return typeof value === 'string' && value !== '' && isAbsolute(value) ? value : undefined
}

function processIdentity(pid) {
  try {
    const output = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, env: { ...process.env, LC_ALL: 'C' }
    }).trim()
    return output === '' ? undefined : output
  } catch { return undefined }
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error?.code === 'ESRCH') return false
    return undefined
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

function ownedByCurrentUser(stat) {
  const uid = currentUid()
  return uid === undefined || stat.uid === uid
}

function secureParent(path) {
  const parent = dirname(path)
  try {
    const existing = lstatSync(parent)
    if (!existing.isDirectory() || existing.isSymbolicLink() || !ownedByCurrentUser(existing)) return false
  } catch (error) {
    if (error?.code !== 'ENOENT') return false
    try { mkdirSync(parent, { recursive: true, mode: 0o700 }) } catch { return false }
    const created = lstatSync(parent)
    if (!created.isDirectory() || created.isSymbolicLink() || !ownedByCurrentUser(created)) return false
  }
  try { chmodSync(parent, 0o700) } catch { return false }
  const checked = lstatSync(parent)
  return checked.isDirectory() && !checked.isSymbolicLink() && ownedByCurrentUser(checked) && (checked.mode & PRIVATE_MASK) === 0
}

function validOwner(value) {
  if (value === null || typeof value !== 'object' || value.version !== OWNER_VERSION) return undefined
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined
  if (typeof value.startIdentity !== 'string' || value.startIdentity === '' || value.startIdentity.length > 256) return undefined
  if (typeof value.token !== 'string' || !/^[a-f0-9]{32}$/.test(value.token)) return undefined
  if (value.dataDir !== undefined && (typeof value.dataDir !== 'string' || !isAbsolute(value.dataDir))) return undefined
  if (value.phase !== undefined && value.phase !== 'preparing' && value.phase !== 'committed') return undefined
  return {
    version: OWNER_VERSION, pid: value.pid, startIdentity: value.startIdentity, token: value.token, dataDir: value.dataDir,
    ...(value.phase === undefined ? {} : { phase: value.phase })
  }
}

function readOwner(path) {
  let before
  try { before = lstatSync(path) } catch (error) {
    return error?.code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unsafe' }
  }
  if (!before.isFile() || before.isSymbolicLink() || !ownedByCurrentUser(before) || (before.mode & PRIVATE_MASK) !== 0 || before.size > MAX_OWNER_BYTES) {
    return { kind: 'unsafe' }
  }
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const raw = readFileSync(fd, 'utf8')
    const after = lstatSync(path)
    if (after.dev !== before.dev || after.ino !== before.ino) return { kind: 'unsafe' }
    const [ownerLine = '', commitLine = ''] = raw.split('\n')
    let owner = validOwner(JSON.parse(ownerLine))
    if (owner?.phase === 'preparing' && commitLine !== '') {
      try {
        const receipt = JSON.parse(commitLine)
        if (receipt?.version === OWNER_VERSION && receipt?.commitToken === owner.token) owner = { ...owner, phase: 'committed' }
      } catch { /* 半截 receipt 仍是可清理的 preparing，不能把唯一 owner 判成永久 unsafe */ }
    }
    return owner === undefined ? { kind: 'unsafe' } : { kind: 'owner', owner, stat: before }
  } catch { return { kind: 'unsafe' } } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* 已关闭 */ }
  }
}

function writeCandidate(path, owner) {
  const temporary = join(dirname(path), `.write-right-${String(process.pid)}-${randomBytes(8).toString('hex')}.tmp`)
  let fd
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    linkSync(temporary, path)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || !ownedByCurrentUser(stat)) throw new Error('WRITE_RIGHT_UNSAFE')
    chmodSync(path, 0o600)
    return { acquired: true, stat }
  } catch (error) {
    if (error?.code === 'EEXIST') return { acquired: false, reason: 'exists' }
    return { acquired: false, reason: 'unavailable' }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* 已关闭 */ }
    try { unlinkSync(temporary) } catch { /* 已链接或未创建 */ }
  }
}

function syncParent(path) {
  let fd
  try {
    fd = openSync(dirname(path), constants.O_RDONLY)
    fsyncSync(fd)
    return true
  } catch { return false } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* 已关闭 */ }
  }
}

function commitCandidate(path, owner, stat, dropDuringCommit = false) {
  const preparing = readOwner(path)
  if (!sameOwnerRecord(preparing, { kind: 'owner', owner, stat }) || preparing.owner.phase !== 'preparing') return false
  let fd
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0))
    const receipt = `${JSON.stringify({ version: OWNER_VERSION, commitToken: owner.token })}\n`
    if (dropDuringCommit) {
      writeFileSync(fd, receipt.slice(0, Math.max(1, Math.floor(receipt.length / 2))), 'utf8')
      process.exit(74)
    }
    writeFileSync(fd, receipt, 'utf8')
    fsyncSync(fd)
  } catch { return false } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* 已关闭 */ }
  }
  const committed = readOwner(path)
  return sameOwnerRecord(committed, { kind: 'owner', owner, stat }) && committed.owner.phase === 'committed'
}

function syncCommittedCandidate(path, owner, stat) {
  const current = readOwner(path)
  if (!sameOwnerRecord(current, { kind: 'owner', owner, stat }) || current.owner.phase !== 'committed') return false
  let fd
  try {
    fd = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
    fsyncSync(fd)
  } catch { return false } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* 已关闭 */ }
  }
  const confirmed = readOwner(path)
  return sameOwnerRecord(confirmed, { kind: 'owner', owner, stat }) && confirmed.owner.phase === 'committed'
}

function removeCandidate(path, stat, skip = false) {
  if (skip) return false
  try {
    const current = lstatSync(path)
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) return false
    unlinkSync(path)
    // 删除的持久化失败也不授予 handle；运行时路径已消失，下一次 acquire 会用自己的成功 fsync 提交新席位。
    syncParent(path)
    return true
  } catch { return false }
}

function recoveryPath(path) {
  return `${path}.recovery`
}

function completedRecoveryPath(path) {
  return `${path}.recovery-completed`
}

// 先把“这个 owner 的账本已经恢复”写进第二个稳定槽位；只有该槽位经目录 fsync
// 确认后才允许移除 recovery。这样任何失败点至少留下旧责任或已完成凭据之一。
function persistCompletedRecovery(path, owner) {
  const marker = completedRecoveryPath(path)
  const temporary = join(dirname(path), `.write-right-completed-${String(process.pid)}-${randomBytes(8).toString('hex')}.tmp`)
  let fd
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, marker)
    chmodSync(marker, 0o600)
    const stored = readOwner(marker)
    if (stored.kind !== 'owner' || stored.owner.token !== owner.token) return false
    return syncParent(marker)
  } catch { return false } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* 已关闭 */ }
    try { unlinkSync(temporary) } catch { /* 已提交或未创建 */ }
  }
}

// 回收旧席位前先把“必须恢复谁的账本”原子落盘。进程若在移走旧锁后被 kill，
// 下一进程仍能从这个稳定路径接过责任，不能把旧死端口误记成自己的原值。
function ensureRecoveryResponsibility(path, owner) {
  const marker = recoveryPath(path)
  const created = writeCandidate(marker, owner)
  if (created.acquired && !syncParent(marker)) return { kind: 'unsafe' }
  if (!created.acquired && created.reason !== 'exists') return { kind: 'unsafe' }
  return readOwner(marker)
}

function staleOwner(record, identityOf, aliveOf) {
  const alive = aliveOf(record.owner.pid)
  if (alive === false) return true
  if (alive !== true) return undefined
  const current = identityOf(record.owner.pid)
  if (current === undefined) return undefined
  return current !== record.owner.startIdentity
}

function sameOwner(record, owner) {
  return record?.kind === 'owner' && owner !== undefined &&
    record.owner.token === owner.token && record.owner.pid === owner.pid &&
    record.owner.startIdentity === owner.startIdentity
}

function sameOwnerRecord(record, expected) {
  return expected?.kind === 'owner' && sameOwner(record, expected.owner) &&
    record.stat.dev === expected.stat.dev && record.stat.ino === expected.stat.ino
}

function ownerRecord(record) {
  return record?.kind === 'owner'
    ? { kind: 'owner', owner: record.owner, stat: { dev: record.stat.dev, ino: record.stat.ino } }
    : record
}

function transitionLockPath(path) {
  return `${path}.transition-lock`
}

function secureTransitionLock(path) {
  const lock = transitionLockPath(path)
  let fd
  try {
    try {
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
      fsyncSync(fd)
    } catch (error) {
      if (error?.code !== 'EEXIST') return false
    } finally {
      if (fd !== undefined) try { closeSync(fd) } catch { /* 已关闭 */ }
    }
    const stat = lstatSync(lock)
    if (!stat.isFile() || stat.isSymbolicLink() || !ownedByCurrentUser(stat)) return false
    chmodSync(lock, 0o600)
    return (lstatSync(lock).mode & PRIVATE_MASK) === 0
  } catch { return false }
}

// 创建、stale 回收与释放都经同一把 BSD flock。文件席位仍保存可诊断 owner 与恢复责任，
// flock 只保护“比较当前 owner → 替换/删除”的极短临界区；进程在临界区崩溃时由内核自动放锁。
// 这消除了 rename 后才核 inode/token 的窗口：第三个争用者不可能在核验/回链之间取得路径。
function transitionUnderMutex(request) {
  const path = request.path
  const pending = readOwner(recoveryPath(path))
  const completed = readOwner(completedRecoveryPath(path))
  if (pending.kind === 'unsafe' || completed.kind === 'unsafe') return { kind: 'unavailable' }

  const current = readOwner(path)
  if (request.operation === 'release') {
    if (current.kind === 'missing') {
      return (request.testFailReleaseDirectorySync === true ? false : syncParent(path))
        ? { kind: 'released' }
        : { kind: 'retry' }
    }
    if (!sameOwnerRecord(current, request.expected)) return { kind: 'not-owner' }
    try {
      unlinkSync(path)
      return (request.testFailReleaseDirectorySync === true ? false : syncParent(path))
        ? { kind: 'released' }
        : { kind: 'retry' }
    } catch { return { kind: 'unavailable' } }
  }

  let reclaimed = false
  let responsibility = pending.kind === 'owner' ? pending : undefined
  if (current.kind === 'owner') {
    if (!sameOwnerRecord(current, request.expected)) return { kind: 'retry' }
    if (responsibility === undefined) {
      const persisted = ensureRecoveryResponsibility(path, current.owner)
      if (persisted.kind !== 'owner') return { kind: 'unavailable' }
      responsibility = persisted
    }
    // 当前记录与调用方判 stale 的 inode/token 仍完全一致，且所有协作者都被 flock 排除；此刻删除就是 CAS。
    try { unlinkSync(path); reclaimed = true } catch { return { kind: 'retry' } }
  } else if (current.kind !== 'missing') return { kind: 'unavailable' }
  else if (request.expected !== undefined) return { kind: 'retry' }

  // 两阶段提交：preparing 的 inode 绝不授权写系统设置；目录项 fsync 成功后才在同一 inode
  // 写 committed 并 fsync 文件。这样 helper 在 link→dir-fsync 窗口被杀时，父进程不会凭 token 误授权。
  const created = writeCandidate(path, { ...request.owner, phase: 'preparing' })
  if (!created.acquired) return { kind: created.reason === 'exists' ? 'retry' : 'unavailable' }
  if (request.testDropTransitionBeforeDirectorySync === true) process.exit(74)
  const directorySynced = request.testFailOwnerDirectorySync === true ? false : syncParent(path)
  if (!directorySynced) {
    return removeCandidate(path, created.stat, request.testFailOwnerCleanup === true)
      ? { kind: 'creation-rolled-back' }
      : { kind: 'preparing', stat: { dev: created.stat.dev, ino: created.stat.ino } }
  }
  if (!commitCandidate(path, request.owner, created.stat, request.testDropTransitionDuringCommit === true)) {
    return removeCandidate(path, created.stat)
      ? { kind: 'creation-rolled-back' }
      : { kind: 'preparing', stat: { dev: created.stat.dev, ino: created.stat.ino } }
  }
  return {
    kind: 'acquired',
    stat: { dev: created.stat.dev, ino: created.stat.ino },
    responsibility: ownerRecord(responsibility),
    reclaimed
  }
}

// execFileSync 的失败并不等于临界区没有提交：helper 可能已 link 新 owner，却在 stdout/JSON
// 返回前被杀或超时。随机 token 是本次请求唯一的提交标识；重读完全匹配即可恢复 handle，
// stale 回收责任则从先于 unlink 持久化的 recovery marker 接回。
function recoverCommittedTransition(request) {
  const current = readOwner(request.path)
  if (request.operation === 'release') {
    // 只看见 missing 证明不了 unlink 已经目录 fsync；让同一 release handle 再进 helper 做确认。
    if (current.kind === 'missing') return undefined
    if (current.kind === 'owner' && !sameOwner(current, request.expected?.owner)) return { kind: 'not-owner' }
    return undefined
  }
  if (!sameOwner(current, request.owner)) return undefined
  if (current.owner.phase === 'preparing') {
    return { kind: 'preparing', stat: { dev: current.stat.dev, ino: current.stat.ino } }
  }
  if (current.owner.phase !== 'committed' || !syncCommittedCandidate(request.path, request.owner, current.stat)) return undefined
  const pending = readOwner(recoveryPath(request.path))
  const completed = readOwner(completedRecoveryPath(request.path))
  if (pending.kind === 'unsafe' || completed.kind === 'unsafe') return undefined
  return {
    kind: 'acquired',
    stat: { dev: current.stat.dev, ino: current.stat.ino },
    responsibility: pending.kind === 'owner' ? ownerRecord(pending) : undefined,
    reclaimed: request.expected !== undefined
  }
}

function runTransition(request) {
  const path = request.path
  if (!secureTransitionLock(path)) return { kind: 'unavailable' }
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url')
  const lockWaitSeconds = request.operation === 'release' ? '1' : '0'
  try {
    const raw = execFileSync(WRITE_LOCK, [
      lockWaitSeconds, transitionLockPath(path),
      process.execPath, fileURLToPath(import.meta.url), TRANSITION_MODE, encoded
    ], { encoding: 'utf8', timeout: 5_000, env: process.env })
    return JSON.parse(raw)
  } catch (error) {
    const committed = recoverCommittedTransition(request)
    if (committed !== undefined) return committed
    // EX_TEMPFAIL(75)只表示另一个 acquire/reclaim 正在极短临界区内；调用方按 deadline 重读。
    return error?.status === 75 ? { kind: 'busy' } : { kind: 'unavailable' }
  }
}

export function acquireWriteRight(options = {}) {
  const path = options.lockPath ?? writeRightPath()
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Math.trunc(options.timeoutMs)) : 0
  const identityOf = options.processIdentity ?? processIdentity
  const aliveOf = options.processAlive ?? processIsAlive
  const wait = options.sleep ?? sleep
  if (!isAbsolute(path) || !secureParent(path)) return { acquired: false, reason: 'unavailable' }
  const startIdentity = identityOf(process.pid)
  if (typeof startIdentity !== 'string' || startIdentity === '') return { acquired: false, reason: 'unavailable' }
  const owner = {
    version: OWNER_VERSION,
    pid: process.pid,
    startIdentity,
    token: randomBytes(16).toString('hex'),
    dataDir: options.dataDir ?? dataDirFromArgv()
  }
  let releaseDirectorySyncFailures = Number.isSafeInteger(options.testFailReleaseDirectorySyncAttempts)
    ? Math.max(0, options.testFailReleaseDirectorySyncAttempts)
    : 0
  let dropResultAfterCommit = options.testDropTransitionResultAfterCommit === true
  let dropBeforeDirectorySync = options.testDropTransitionBeforeDirectorySync === true
  let failOwnerDirectorySync = options.testFailOwnerDirectorySync === true
  let failOwnerCleanup = options.testFailOwnerCleanup === true
  let dropDuringCommit = options.testDropTransitionDuringCommit === true
  let creationRetries = 0
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pendingRecovery = readOwner(recoveryPath(path))
    const completedRecovery = readOwner(completedRecoveryPath(path))
    if (pendingRecovery.kind === 'unsafe') return { acquired: false, reason: 'unavailable' }
    if (completedRecovery.kind === 'unsafe') return { acquired: false, reason: 'unavailable' }
    const current = readOwner(path)
    if (current.kind === 'unsafe') return { acquired: false, reason: 'unavailable' }
    let expected
    if (current.kind === 'owner') {
      if (current.owner.phase === 'preparing' && current.owner.pid === process.pid && current.owner.startIdentity === startIdentity) {
        const cleaned = runTransition({ operation: 'release', path, expected: ownerRecord(current) })
        if (cleaned.kind === 'released' || cleaned.kind === 'not-owner') {
          creationRetries += 1
          if (creationRetries <= 3) continue
        }
        return { acquired: false, reason: 'unavailable' }
      }
      const stale = staleOwner(current, identityOf, aliveOf)
      if (stale === undefined) return { acquired: false, reason: 'unavailable' }
      if (!stale) {
        if (Date.now() >= deadline) return { acquired: false, reason: 'held' }
        wait(Math.min(POLL_MS, Math.max(1, deadline - Date.now())))
        continue
      }
      expected = ownerRecord(current)
    }

    const transitionRequest = {
      operation: 'acquire', path, owner, expected,
      testDropResultAfterCommit: dropResultAfterCommit,
      testDropTransitionBeforeDirectorySync: dropBeforeDirectorySync,
      testFailOwnerDirectorySync: failOwnerDirectorySync,
      testFailOwnerCleanup: failOwnerCleanup,
      testDropTransitionDuringCommit: dropDuringCommit
    }
    dropResultAfterCommit = false
    dropBeforeDirectorySync = false
    failOwnerDirectorySync = false
    failOwnerCleanup = false
    dropDuringCommit = false
    const transitioned = runTransition(transitionRequest)
    if (transitioned.kind === 'creation-rolled-back') {
      creationRetries += 1
      if (creationRetries <= 3) continue
      return { acquired: false, reason: 'unavailable' }
    }
    if (transitioned.kind === 'preparing') {
      const cleaned = runTransition({
        operation: 'release', path,
        expected: { kind: 'owner', owner, stat: transitioned.stat }
      })
      creationRetries += 1
      if ((cleaned.kind === 'released' || cleaned.kind === 'not-owner') && creationRetries <= 3) continue
      return { acquired: false, reason: 'unavailable' }
    }
    if (transitioned.kind === 'acquired') {
      const created = { stat: transitioned.stat }
      const responsibility = transitioned.responsibility?.kind === 'owner' ? transitioned.responsibility : undefined
      if (transitioned.reclaimed) options.afterStaleRemoved?.()
      let released = false
      let recoveryCompleted = responsibility === undefined
      return {
        acquired: true,
        abandoned: responsibility !== undefined,
        previousOwner: responsibility?.owner,
        assertHeld() {
          const current = readOwner(path)
          if (!sameOwnerRecord(current, { kind: 'owner', owner, stat: created.stat }) || current.owner.phase !== 'committed') {
            throw Object.assign(new Error('TUNNEL_WRITE_RIGHT_LOST:macOS 系统代理写入权已变化'), {
              code: 'TUNNEL_WRITE_RIGHT_LOST'
            })
          }
        },
        completeRecovery() {
          if (recoveryCompleted) return true
          const current = readOwner(path)
          const pending = readOwner(recoveryPath(path))
          if (current.kind !== 'owner' || current.owner.token !== owner.token ||
              current.stat.dev !== created.stat.dev || current.stat.ino !== created.stat.ino ||
              pending.kind !== 'owner' || pending.owner.token !== responsibility.owner.token ||
              pending.stat.dev !== responsibility.stat.dev || pending.stat.ino !== responsibility.stat.ino) return false
          // completed 是第二阶段提交点：它先持久化，之后 recovery 才不再是唯一责任。
          // 若任一持久化步骤失败，旧 recovery 原样保留，下一进程仍会拿到原 owner。
          if (!persistCompletedRecovery(path, responsibility.owner)) return false
          options.afterRecoveryCompletedPersisted?.()
          try {
            unlinkSync(recoveryPath(path))
            options.afterRecoveryResponsibilityRemoved?.()
            // completed 已经持久化；即使这次目录 fsync 报错，崩溃后 recovery 重新出现也只会安全地重复恢复。
            syncParent(recoveryPath(path))
            recoveryCompleted = true
            return true
          } catch { return false }
        },
        release() {
          if (released) return true
          // transition 临界区很短；偶发 busy/子进程失败先在本次交还里有界重试。
          // 仍未确认时返回 false 并保留 released=false，让上层持有同一 right 后续再试，不能自锁成活 PID 的 held。
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const failDirectorySync = releaseDirectorySyncFailures > 0
            if (failDirectorySync) releaseDirectorySyncFailures -= 1
            const result = runTransition({
              operation: 'release', path, expected: { kind: 'owner', owner, stat: created.stat },
              testFailReleaseDirectorySync: failDirectorySync
            })
            if (result.kind === 'released' || result.kind === 'not-owner') {
              released = true
              return true
            }
            if (attempt < 2) wait(POLL_MS)
          }
          return false
        }
      }
    }
    if (transitioned.kind === 'unavailable') return { acquired: false, reason: 'unavailable' }
    if (Date.now() >= deadline) return { acquired: false, reason: 'held' }
    wait(Math.min(POLL_MS, Math.max(1, deadline - Date.now())))
  }
}

if (process.argv[2] === TRANSITION_MODE) {
  let result = { kind: 'unavailable' }
  try {
    const request = JSON.parse(Buffer.from(process.argv[3] ?? '', 'base64url').toString('utf8'))
    result = transitionUnderMutex(request)
    if (request.testDropResultAfterCommit === true && result.kind === 'acquired') process.exit(74)
  } catch { /* 保守拒绝 */ }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
