import { join } from 'node:path'
import { createDeepSeekAdapters, observedConfigurationExecution } from './adapters'
import { createProjectConfigurationTargetStore } from './configuration-target'
import { createConfigurationExecutionObserver, configurationObservationTtlMs } from './configuration-execution-observer'
import { createManagedTextFile } from './file'

/** GUI management and uninstall resolve exactly the same private, customer-selected targets. */
export function createProductionAiAccessAdapters(userData: string, home: string, platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) {
  const file = createManagedTextFile()
  const observeConfigurationExecution = createConfigurationExecutionObserver({ platform, home, ttlMs: configurationObservationTtlMs })
  return createDeepSeekAdapters({ home, platform, localAppData: environment.LOCALAPPDATA, hermesHome: environment.HERMES_HOME,
    hermesIsolationRegistryPath: join(userData, 'ai-access', 'hermes-isolation-targets.json'),
    configurationExecution: observedConfigurationExecution(home, platform, environment), observeConfigurationExecution,
    projectTargetStore: createProjectConfigurationTargetStore(file, join(userData, 'ai-access', 'private-project-targets.json'), platform),
    claudeIsolationLeaseRegistryPath: join(userData, 'ai-access', 'laixin-claude-isolation-target.json'), file })
}
