import { join } from 'node:path'
import { AiAccessService, aiAccessShells, type AiAccessState } from '../../../app/main/ai-access/service'
import { createAiAccessStore } from '../../../app/main/ai-access/store'
import { AiGateway } from '../../../app/main/ai-access/gateway'
import { AiRouterController } from '../../../app/main/ai-access/router-controller'

/** Exercise the real service/controller; only OS resident installation is replaced in this fixture. */
class FixtureController extends AiRouterController {
  override ensureReady(state: AiAccessState) { return super.ensureReady(state, false) }
  override async stop(): Promise<boolean> { throw new Error('GUI_MUST_NOT_STOP_CLIENT_RUNTIME') }
}

export async function fixtureGui(root: string, bootstrap: string) {
  const store = createAiAccessStore(join(root, 'ai-access'))
  const controller = new FixtureController(root, { executable: process.execPath, appPath: bootstrap, logDir: join(root, 'logs') }, { preferSpawn: true })
  const gateway = new AiGateway()
  const service = new AiAccessService(store, aiAccessShells.map(shell => ({ shell, applyDeepSeek: async () => undefined })),
    gateway, { independentRouting: true }, controller)
  await service.initialize()
  const state = await store.read()
  const status = await service.serviceStatus()
  return { service, report: { guiPid: process.pid, running: status.running, startupError: status.startupError,
    singlePort: state.relay?.port, controlPort: state.codexMultiRelay?.port, routeCount: status.routes.length } }
}
