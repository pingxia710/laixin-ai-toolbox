/**
 * N-55 keeps the decision facts for one connection intent together.  It is
 * deliberately platform-neutral: adapters still own reading/writing system
 * settings, while this controller fences every asynchronous decision by the
 * intent generation, the observed conflict object and the path evidence that
 * authorised it.
 */

export const AVAILABILITY_ACTIONS = Object.freeze(['inspect', 'reuse', 'takeover', 'reclaim', 'restore'])
export const AVAILABILITY_STATUSES = Object.freeze(['examining', 'reusing', 'taking-over', 'reclaiming', 'recovering', 'connected', 'recovered', 'limited'])

const MUTATING_ACTIONS = new Set(['takeover', 'reclaim', 'restore'])

function validObject(value) {
  return value !== null && typeof value === 'object'
}

function sameIdentity(left, right) {
  return validObject(left) && validObject(right) && typeof left.id === 'string' && left.id !== '' && left.id === right.id
}

function sameIntent(left, right) {
  return sameIdentity(left, right) && Number.isSafeInteger(left.generation) && left.generation === right.generation
}

function hasIdentity(value) {
  return validObject(value) && typeof value.id === 'string' && value.id !== ''
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function actionStatus(action) {
  return {
    inspect: 'examining',
    reuse: 'reusing',
    takeover: 'taking-over',
    reclaim: 'reclaiming',
    restore: 'recovering'
  }[action] ?? 'limited'
}

function safeAction(operation) {
  return {
    id: operation.id,
    action: operation.action,
    writes: operation.writes,
    intent: operation.intent,
    conflict: { id: operation.conflict?.id, kind: operation.conflict?.kind },
    path: { id: operation.path?.id, target: operation.path?.target },
    lease: operation.lease === undefined ? undefined : { id: operation.lease.id, owner: operation.lease.owner }
  }
}

function safeBlockedAction(action, { intent, conflict, path } = {}) {
  if (!validObject(intent) || typeof intent.id !== 'string' || !Number.isSafeInteger(intent.generation)) return undefined
  if (!hasIdentity(conflict) || !hasIdentity(path)) return undefined
  return {
    action,
    writes: 0,
    intent: clone(intent),
    conflict: { id: conflict.id, kind: conflict.kind },
    path: { id: path.id, target: path.target }
  }
}

/**
 * A narrow state machine rather than a second settings adapter.  The caller
 * provides real read/write/probe results; this class only decides whether a
 * result still belongs to the action that caused it.
 */
export class NetworkAvailabilityController {
  constructor({ now = Date.now, maxReclaims = 3 } = {}) {
    this.now = now
    this.maxReclaims = maxReclaims
    this.generation = 0
    this.sequence = 0
    this.operations = new Map()
    this.activeIntent = undefined
    this.activeOperation = undefined
    this.reclaims = 0
    this.state = { status: 'examining', intentGeneration: 0 }
  }

  beginIntent({ id }) {
    if (typeof id !== 'string' || id === '') throw new TypeError('AVAILABILITY_INTENT_ID_REQUIRED')
    this.releaseAll({ cancelled: true })
    this.generation += 1
    this.activeIntent = Object.freeze({ id, generation: this.generation })
    this.reclaims = 0
    this.state = { status: 'examining', intentGeneration: this.generation, action: 'inspect' }
    return this.activeIntent
  }

  isCurrent(operation) {
    return operation !== undefined && this.activeIntent !== undefined &&
      operation.intent.id === this.activeIntent.id && operation.intent.generation === this.activeIntent.generation &&
      operation.cancelled !== true && this.activeOperation === operation.id && this.operations.get(operation.id) === operation
  }

  /** Keep only in-flight evidence. Terminal evidence is reduced to state.lastAction before the raw operation is released. */
  release(operation, { cancelled = false } = {}) {
    if (operation === undefined) return
    if (cancelled) operation.cancelled = true
    this.operations.delete(operation.id)
    if (this.activeOperation === operation.id) this.activeOperation = undefined
    // A late callback needs its identity only to be rejected as stale; it must not retain the former setting snapshot or write value.
    delete operation.snapshot
    delete operation.writtenValue
  }

  releaseAll({ cancelled = false } = {}) {
    for (const operation of this.operations.values()) this.release(operation, { cancelled })
    this.activeOperation = undefined
  }

  start(input) {
    const { intent, action, conflict, path, snapshot, lease, restriction } = input ?? {}
    // 旧代次只拿到一个局部结果，绝不能把当前代次已经确认的状态改成 stale/limited。
    if (!sameIntent(intent, this.activeIntent)) return this.stale(action)
    if (!AVAILABILITY_ACTIONS.includes(action)) return this.block(action, 'STALE_OPERATION')
    if (typeof restriction === 'string' && restriction !== '') return this.block(action, restriction, { intent, conflict, path })
    if (!hasIdentity(conflict) || !hasIdentity(path)) return this.block(action, 'OBJECT_IDENTITY_MISSING')
    if (MUTATING_ACTIONS.has(action) && (!hasIdentity(snapshot) || !hasIdentity(lease))) {
      return this.block(action, 'RECOVERY_CONTRACT_MISSING')
    }
    if (action === 'reclaim' && this.reclaims >= this.maxReclaims) return this.block(action, 'RECLAIM_LIMIT')
    if (this.activeOperation !== undefined) {
      const previous = this.operations.get(this.activeOperation)
      this.release(previous, { cancelled: true })
    }
    const recoveryCause = action === 'restore' && this.state.status === 'limited' && typeof this.state.code === 'string'
      ? this.state.code : undefined
    const operation = {
      id: `availability:${intent.generation}:${++this.sequence}`,
      blocked: false,
      action,
      intent: clone(intent),
      conflict: clone(conflict),
      path: clone(path),
      snapshot: clone(snapshot),
      lease: clone(lease),
      writes: 0,
      writtenValue: clone(input.writtenValue ?? (lease === undefined ? undefined : { lease: lease.id })),
      startedAt: this.now(),
      recoveryCause,
      cancelled: false,
      written: false
    }
    this.operations.set(operation.id, operation)
    this.activeOperation = operation.id
    this.state = { status: actionStatus(action), intentGeneration: intent.generation, action, lastAction: safeAction(operation),
      ...(recoveryCause === undefined ? {} : { code: recoveryCause }) }
    return operation
  }

  markWritten(operation) {
    if (!this.isCurrent(operation) || !MUTATING_ACTIONS.has(operation.action)) return false
    // 夺回预算按真正执行的“轮”计：目标复验随后失败也已改过一次设置，不能借失败无限重写。
    if (operation.action === 'reclaim' && operation.writes === 0) this.reclaims += 1
    operation.written = true
    operation.writes += 1
    return true
  }

  complete(operation, { readbackMatches, targetReachable, conflict, path } = {}) {
    if (!this.isCurrent(operation)) return this.outcome(false, 'STALE_OPERATION', 'limited')
    if (!sameIdentity(conflict, operation.conflict) || !sameIdentity(path, operation.path)) {
      this.state = { status: 'limited', intentGeneration: operation.intent.generation, action: operation.action,
        code: 'EVIDENCE_CHANGED', lastAction: safeAction(operation) }
      this.release(operation, { cancelled: true })
      return this.outcome(false, 'EVIDENCE_CHANGED', 'limited')
    }
    if (MUTATING_ACTIONS.has(operation.action) && (operation.writes === 0 || readbackMatches !== true)) return this.fail(operation, 'READBACK_MISMATCH')
    if (targetReachable !== true) return this.fail(operation, 'TARGET_UNREACHABLE')
    operation.completed = true
    this.state = {
      status: 'connected', intentGeneration: operation.intent.generation, action: operation.action,
      lastAction: safeAction(operation)
    }
    this.release(operation)
    return this.outcome(true, undefined, 'connected')
  }

  cancel(operation, stage) {
    if (!this.isCurrent(operation)) return this.outcome(false, 'STALE_OPERATION', 'limited')
    operation.cancelStage = stage
    this.state = { status: 'recovering', intentGeneration: operation.intent.generation, action: 'restore', lastAction: safeAction(operation) }
    this.release(operation, { cancelled: true })
    return this.outcome(true, undefined, 'recovering')
  }

  /**
   * The caller performs the actual write.  A snapshot is restored only while
   * the observed value still equals this operation's write; a third-party
   * value is recorded as preserved and is never overwritten.
   */
  recover(operation, { currentValue, readbackMatches } = {}) {
    if (!this.isCurrent(operation)) return this.outcome(false, 'STALE_OPERATION', 'limited')
    if (operation.written !== true) return this.fail(operation, 'WRITE_NOT_OWNED')
    const preservedExternal = !deepEqual(currentValue, operation.writtenValue)
    if (!preservedExternal && readbackMatches !== true) return this.fail(operation, 'RESTORE_READBACK_MISMATCH')
    const restoreValue = preservedExternal ? undefined : clone(operation.snapshot?.value)
    operation.recovered = true
    this.state = {
      status: 'recovered', intentGeneration: operation.intent.generation, action: 'restore',
      lastAction: safeAction(operation), preservedExternal,
      ...(operation.recoveryCause === undefined ? {} : { code: operation.recoveryCause })
    }
    this.release(operation)
    return { ok: true, status: 'recovered', preservedExternal, restoreValue }
  }

  /** Ledger-backed recovery has already compared every setting with its write and read every restored value.
   * It reports only the aggregate, so the controller records the phase without serialising any setting value. */
  finishRecovery(operation, { readbackMatches, preservedExternal = false } = {}) {
    if (!this.isCurrent(operation)) return this.outcome(false, 'STALE_OPERATION', 'limited')
    if (readbackMatches !== true) return this.fail(operation, 'RESTORE_READBACK_MISMATCH')
    operation.recovered = true
    this.state = {
      status: 'recovered', intentGeneration: operation.intent.generation, action: 'restore',
      lastAction: safeAction(operation), preservedExternal,
      ...(operation.recoveryCause === undefined ? {} : { code: operation.recoveryCause })
    }
    this.release(operation)
    return this.outcome(true, undefined, 'recovered')
  }

  stale(action) {
    return { blocked: true, status: 'limited', action, code: 'STALE_OPERATION' }
  }

  block(action, code, evidence) {
    // A current restriction supersedes every operation already in flight for
    // this intent.  Otherwise its late success could erase the restriction.
    if (this.activeOperation !== undefined) {
      const operation = this.operations.get(this.activeOperation)
      this.release(operation, { cancelled: true })
    }
    const lastAction = safeBlockedAction(action, evidence) ?? this.state.lastAction
    this.state = { status: 'limited', intentGeneration: this.activeIntent?.generation ?? 0, action, code,
      ...(lastAction === undefined ? {} : { lastAction }) }
    return { blocked: true, status: 'limited', action, code }
  }

  fail(operation, code) {
    if (!this.isCurrent(operation)) return this.outcome(false, 'STALE_OPERATION', 'limited')
    this.state = { status: 'limited', intentGeneration: operation.intent.generation, action: operation.action, code, lastAction: safeAction(operation) }
    this.release(operation)
    return this.outcome(false, code, 'limited')
  }

  outcome(ok, code, status) {
    return code === undefined ? { ok, status } : { ok, status, code }
  }
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}
