import { trustedCliExecutable, trustedCliExecutables } from '../shells/inventory'

export interface CodexCommand { readonly executable: string; readonly args: readonly string[] }

// Never inspect PATH. The global npm launcher is a wrapper; only its fixed native vendor binary
// (or a fixed app bundle binary) is allowed to serve account and verification flows.
export async function findCodexCommand(home: string, platform = process.platform, env = process.env, arch = process.arch): Promise<CodexCommand | null> {
  void arch // Retained for callers compiled against the earlier discovery signature.
  const executable = await trustedCliExecutable('codex', platform, home, env)
  return executable === undefined ? null : { executable, args: ['app-server', '--listen', 'stdio://'] }
}

/** Provider-bound workspaces require the native Desktop deep-link owner, not a CLI-only install. */
export async function findCodexDesktopCommand(home: string, platform = process.platform, env = process.env): Promise<CodexCommand | null> {
  const executables = await trustedCliExecutables('codex', platform, home, env)
  const executable = executables.find(candidate => isCodexDesktopExecutable(candidate, platform))
  return executable === undefined ? null : { executable, args: ['app-server', '--listen', 'stdio://'] }
}

export function isCodexDesktopExecutable(executable: string, platform: string): boolean {
  const normalized = executable.replace(/\\/g, '/')
  if (platform === 'darwin') return /\/(?:Codex|ChatGPT)\.app\/Contents\/Resources\/codex$/.test(normalized)
  if (platform === 'win32') return /\/AppData\/Local\/(?:Programs\/(?:Codex|ChatGPT)|ChatGPT)\/resources\/codex\.exe$/i.test(normalized)
  return false
}
