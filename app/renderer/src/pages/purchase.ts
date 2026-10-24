import type { PageModule } from './types'
import { mountSubscriptions } from '../subscription/view'
let dispose = (): void => undefined

export const page: PageModule = {
  moduleId: 'subscription.orders',
  tab: 'purchase',
  order: 0,
  mount: (element) => {
    dispose(); dispose = mountSubscriptions(element)
  },
  unmount: () => dispose()
}
