const shells = new Set(['codex', 'claude', 'hermes'])
const statuses = new Set(['passed-native-cli-local-upstream', 'failed', 'configuration-failed', 'not-tested-no-native-binary'])

/**
 * Native clients have different machine-readable completion contracts. Never search their
 * combined stdout/stderr for a word from our prompt: an echoed prompt or an error can contain
 * `OK` without a completed assistant answer.
 */
function nativeAssistantFinalText(shell, stdout) {
  if (!shells.has(shell) || typeof stdout !== 'string' || stdout.length > 64 * 1024) return undefined
  if (shell === 'hermes') {
    // `hermes chat -Q` suppresses progress and writes its final response to stdout. A normal
    // answer is allowed to vary in punctuation, but diagnostic output can never prove success.
    const response = stdout.trim()
    const lines = response.split(/\r?\n/).filter(line => line.trim() !== '')
    return response && !lines.some(line => /^(?:error|fatal|exception|traceback)\b(?:\s*:|\s|$)/i.test(line.trim())) ? response : undefined
  }

  const events = jsonLines(stdout)
  if (events.length === 0) return undefined
  if (shell === 'codex') {
    let finalAssistantText
    let turnCompleted = false
    for (const event of events) {
      if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        finalAssistantText = event.item.text
      }
      if (event?.type === 'turn.completed') turnCompleted = true
      if (event?.type === 'turn.failed' || event?.type === 'error') return undefined
    }
    return turnCompleted && typeof finalAssistantText === 'string' ? finalAssistantText : undefined
  }

  const final = events.at(-1)
  return final?.type === 'result' && final.subtype === 'success' && final.is_error !== true && typeof final.result === 'string'
    ? final.result : undefined
}

/** A real-provider run proves a completed native answer, without making correctness depend on punctuation from the model. */
export function nativeAssistantReplyCompleted(shell, stdout) {
  const response = nativeAssistantFinalText(shell, stdout)
  return typeof response === 'string' && response.trim().length > 0
}

export function nativeAssistantReplyIsOk(shell, stdout) {
  const response = nativeAssistantFinalText(shell, stdout)
  if (typeof response !== 'string') return false
  // Hermes can emit one harmless setup/title line before the quiet-mode final answer.  The
  // deterministic fixture reply must still be the last non-empty assistant output; don't call
  // an otherwise completed native request a failure merely because that auxiliary line exists.
  if (shell === 'hermes') return response.split(/\r?\n/).reverse().find(line => line.trim() !== '')?.trim() === 'OK'
  return response.trim() === 'OK'
}

function jsonLines(stdout) {
  const values = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed)
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      values.push(value)
    } catch { return [] }
  }
  return values
}

/** The local acceptance runner may never print a temporary path, process error, Key, or raw CLI output. */
export function safeCliResult(shell, status, details = {}) {
  if (!shells.has(shell) || !statuses.has(status)) throw new Error('result_invalid')
  const result = { shell, status }
  if (details.exitCode === null || Number.isSafeInteger(details.exitCode)) result.exitCode = details.exitCode
  if (Number.isSafeInteger(details.requests) && details.requests >= 0) result.requests = details.requests
  if (status === 'configuration-failed') result.reason = 'configuration_failed'
  return result
}
