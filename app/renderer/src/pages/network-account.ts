import type { PageModule } from './types'
import { onAccountChange, refreshAccount } from '../account-state'
import { mountAccountOverview, textNode } from '../ui/account-overview'

let cleanup = (): void => undefined
export const page: PageModule = {
  moduleId: 'network.account', tab: 'tunnel', order: 10,
  mount: (element) => {
    cleanup()
    cleanup = onAccountChange((view) => {
      mountAccountOverview(element, view, 'tunnel')
      if (view.state !== 'signed-out' && view.message) { const message = textNode('p', view.message); message.setAttribute('role', 'status'); element.prepend(message) }
    })
    void refreshAccount()
  }, unmount: () => cleanup()
}
