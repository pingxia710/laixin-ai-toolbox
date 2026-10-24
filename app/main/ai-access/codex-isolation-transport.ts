/** Codex-only compatibility names. Other applications import application-isolation-transport directly. */
export {
  ApplicationIsolationHttpConnectTransport as CodexIsolationTransport,
  type ApplicationIsolationHttpConnectSession as CodexIsolationSession,
  type ApplicationIsolationHttpConnectSessionFactory as CodexIsolationSessionFactory,
  type ApplicationIsolationProxyConfig as CodexIsolationProxyConfig
} from './application-isolation-transport'
