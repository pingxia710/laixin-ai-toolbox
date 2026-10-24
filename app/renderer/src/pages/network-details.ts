import type { PageModule } from './types'
import { mountTunnelDetails } from './tunnel'

let cleanup = (): void => undefined
export const page: PageModule = {
  moduleId: 'network.details', tab: 'tunnel', order: 20,
  mount: (element) => { cleanup = mountTunnelDetails(element) },
  unmount: () => cleanup()
}
