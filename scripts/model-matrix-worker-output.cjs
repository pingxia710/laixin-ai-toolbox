const providers = new Set(['deepseek', 'zhipu-api', 'zhipu', 'moonshot', 'kimi'])
const shells = new Set(['codex', 'claude', 'hermes'])
const states = new Set(['passed', 'failed', 'skipped'])
const reasons = new Set([
  'key_rejected', 'key_product_mismatch', 'balance_or_access', 'rate_limited', 'model_unavailable',
  'membership_model_unavailable', 'membership_benefits_unavailable', 'membership_quota_exhausted',
  'membership_concurrency_limited', 'membership_rate_limited', 'coding_plan_expired', 'coding_plan_quota_exhausted',
  'coding_plan_model_unavailable', 'coding_plan_key_product_mismatch', 'request_invalid', 'content_too_long',
  'provider_outage', 'upstream_error', 'network_error', 'client_aborted', 'timeout', 'invalid_reply',
  'tool_call_failed', 'configuration_failed', 'configuration_rollback_failed', 'configuration_interrupted',
  'port_unavailable', 'local_service_down', 'local_service_busy', 'not_configured', 'key_missing',
  'shell_version_incompatible', 'unknown', 'shell_missing', 'version_gate', 'safe_storage_unavailable',
  'state_unavailable', 'matrix_failed'
])

/** The matrix can use real customer state, so its process output is an allowlisted status record only. */
function fixedMatrixWorkerOutput(input) {
  const status = states.has(input && input.status) || input?.status === 'completed' ? input.status : 'failed'
  const result = { status }
  if (providers.has(input?.provider)) result.provider = input.provider
  if (shells.has(input?.shell)) result.shell = input.shell
  if (reasons.has(input?.reason)) result.reason = input.reason
  return JSON.stringify(result)
}

function fixedMatrixWorkerEntry(entry) {
  return fixedMatrixWorkerOutput({
    status: entry?.state,
    provider: entry?.provider,
    shell: entry?.shell,
    reason: entry?.state === 'failed' ? entry.code : entry?.state === 'skipped' ? entry.skipped : undefined
  })
}

function fixedMatrixWorkerFailure(reason) {
  return fixedMatrixWorkerOutput({ status: 'failed', reason: reasons.has(reason) ? reason : 'matrix_failed' })
}

/** The process may exit only after `probeMatrix` has awaited the persistence callback. */
async function finishMatrixWorker(service, write, exit, afterReport) {
  const report = await service.probeMatrix()
  for (const entry of report.entries) write(fixedMatrixWorkerEntry(entry))
  await afterReport?.(report)
  await service.stop()
  write(fixedMatrixWorkerOutput({ status: 'completed' }))
  exit(0)
  return report
}

module.exports = { finishMatrixWorker, fixedMatrixWorkerEntry, fixedMatrixWorkerFailure, fixedMatrixWorkerOutput }
