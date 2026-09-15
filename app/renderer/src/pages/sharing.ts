import type { PageModule } from './types'
import { mountSharing } from '../sharing/view'
let dispose = (): void => undefined

export const page: PageModule = {
  moduleId: 'sharing.rentals',
  tab: 'sharing',
  order: 0,
  mount: (element) => {
    dispose(); dispose = mountSharing(element)
  },
  unmount: () => dispose()
}
