/** Codex-only compatibility names. Other applications import application-isolation-lease directly. */
export {
  ApplicationIsolationLeaseController as CodexAppIsolationController,
  type ApplicationIsolationAdapter as CodexIsolationAdapter,
  type ApplicationIsolationCode as CodexIsolationCode,
  type ApplicationIsolationConfiguration as CodexIsolationConfiguration,
  type ApplicationIsolationEntry as CodexIsolationEntry,
  type ApplicationIsolationLeaseControllerOptions as CodexAppIsolationControllerOptions,
  type ApplicationIsolationLeaseStatus as CodexIsolationStatus,
  type ApplicationIsolationPhase as CodexIsolationPhase,
  type ApplicationIsolationRestoreResult as CodexIsolationRestoreResult,
  type ApplicationIsolationSystemGuard as CodexIsolationSystemGuard
} from './application-isolation-lease'
