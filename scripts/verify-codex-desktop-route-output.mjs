const reasons = new Set([
  'verified_socket_bound_desktop',
  'awaiting_desktop_request',
  'incomplete_answer',
  'platform_unsupported',
  'socket_metadata_unavailable',
  'socket_owner_not_found',
  'socket_owner_ambiguous',
  'socket_owner_not_codex_desktop',
  'desktop_signature_unverified',
  'socket_binding_unavailable'
])

/**
 * Project a loopback diagnostic response to its public three fields. This is only a structural
 * sanitizer: it cannot authenticate the process behind a caller-provided port, so callers must
 * never use its `verified` shape as Desktop acceptance.
 */
export function readGatewayDesktopRouteStatus(value) {
  if (!record(value)) return unavailableDesktopRouteResult()
  const at = value.at
  if (!reasons.has(value.reason) ||
    !((value.status === 'verified' && typeof at === 'string' && validTime(at) && value.reason === 'verified_socket_bound_desktop') ||
      (value.status === 'unverified' && at === null && value.reason !== 'verified_socket_bound_desktop'))) return unavailableDesktopRouteResult()
  return Object.freeze({ status: value.status, at, reason: value.reason })
}

/** A failed local read cannot invent a reason or a pass. */
export function unavailableDesktopRouteResult() {
  return Object.freeze({ status: 'unverified', at: null, reason: 'socket_binding_unavailable' })
}

function validTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }
