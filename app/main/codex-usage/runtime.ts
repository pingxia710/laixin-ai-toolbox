import { trustedCliExecutable } from '../shells/inventory'

export interface CodexCommand { readonly executable: string; readonly args: readonly string[] }

// Never inspect PATH. The global npm launcher is a wrapper; only its fixed native vendor binary
// (or a fixed app bundle binary) is allowed to serve account and verification flows.
export async function findCodexCommand(home: string, platform = process.platform, env = process.env, arch = process.arch): Promise<CodexCommand | null> {
  void arch // Retained for callers compiled against the earlier discovery signature.
  const executable = await trustedCliExecutable('codex', platform, home, env)
  return executable === undefined ? null : { executable, args: ['app-server', '--listen', 'stdio://'] }
}
