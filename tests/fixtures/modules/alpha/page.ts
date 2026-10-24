import type { PageModule } from './types'

const state = { count: 0 }
let activeElement: HTMLElement | undefined
let listener: (() => void) | undefined
let listenerCount = 0

export const page: PageModule = {
  moduleId: 'example.alpha',
  tab: 'tunnel',
  order: 10,
  mount: (element) => {
    activeElement = element
    listener = () => {
      state.count += 1
      render(element)
    }
    element.addEventListener('click', listener)
    listenerCount += 1
    render(element)
  },
  unmount: () => {
    if (activeElement !== undefined && listener !== undefined) {
      activeElement.removeEventListener('click', listener)
      listenerCount -= 1
      activeElement.dataset.listenerCount = String(listenerCount)
    }
    activeElement = undefined
    listener = undefined
  },
}

function render(element: HTMLElement): void {
  element.textContent = `alpha:${state.count}`
  element.dataset.listenerCount = String(listenerCount)
}
