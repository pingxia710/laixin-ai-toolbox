export type CodexDesktopRouteReason =
  | 'verified_socket_bound_desktop'
  | 'awaiting_desktop_request'
  | 'incomplete_answer'
  | 'platform_unsupported'
  | 'socket_metadata_unavailable'
  | 'socket_owner_not_found'
  | 'socket_owner_ambiguous'
  | 'socket_owner_not_codex_desktop'
  | 'desktop_signature_unverified'
  | 'socket_binding_unavailable'

export interface CodexDesktopRouteResult {
  readonly status: 'verified' | 'unverified'
  readonly at: string | null
  readonly reason: CodexDesktopRouteReason
}

export function readGatewayDesktopRouteStatus(value: unknown): CodexDesktopRouteResult
export function unavailableDesktopRouteResult(): CodexDesktopRouteResult
