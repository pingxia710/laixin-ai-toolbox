export function safeCliResult(
  shell: string,
  status: string,
  details?: { readonly exitCode?: number | null; readonly requests?: number; readonly [key: string]: unknown }
): { readonly shell: string; readonly status: string; readonly exitCode?: number | null; readonly requests?: number; readonly reason?: string }

export function nativeAssistantReplyIsOk(shell: string, stdout: string): boolean

export function nativeAssistantReplyCompleted(shell: string, stdout: string): boolean
