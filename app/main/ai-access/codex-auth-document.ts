/** A renderer-safe decision about the Codex credential file; it never contains a credential value. */
export interface CodexOfficialAuthStatus {
  readonly state: 'official' | 'login-required'
  readonly reason: 'chatgpt-session' | 'other-tool-api-key' | 'no-authentication' | 'unrecognized-authentication'
}

/**
 * Codex persists a ChatGPT login as a refreshable token bundle. A standalone OPENAI_API_KEY is
 * the shape written by CC Switch. We never rewrite either: an unproven credential requires the
 * customer to complete the official login flow before we call it an official connection.
 */
export function inspectCodexOfficialAuthentication(contents: string | undefined): CodexOfficialAuthStatus {
  if (contents === undefined) return { state: 'login-required', reason: 'no-authentication' }
  try {
    const value: unknown = JSON.parse(contents)
    if (!record(value)) return { state: 'login-required', reason: 'unrecognized-authentication' }
    // A leftover CC Switch key can coexist with an old token bundle. Codex may still honor the
    // key, so this is never evidence that the official route is restored.
    if (nonEmptyString(value.OPENAI_API_KEY)) {
      return { state: 'login-required', reason: 'other-tool-api-key' }
    }
    if (hasChatGptSession(value)) return { state: 'official', reason: 'chatgpt-session' }
    return { state: 'login-required', reason: 'unrecognized-authentication' }
  } catch {
    return { state: 'login-required', reason: 'unrecognized-authentication' }
  }
}

function hasChatGptSession(value: Record<string, unknown>): boolean {
  if (!record(value.tokens)) return false
  return nonEmptyString(value.tokens.access_token) && nonEmptyString(value.tokens.refresh_token)
}

function nonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
