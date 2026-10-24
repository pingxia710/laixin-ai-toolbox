import type { ShutdownRegistry } from './shutdown-registry'

interface PreventableQuitEvent {
  preventDefault(): void
}

interface QuitApplication {
  on(event: 'before-quit' | 'will-quit', listener: (event: PreventableQuitEvent) => void): void
  exit(code?: number): void
}

export function installShutdownLifecycle(
  electronApp: QuitApplication,
  registry: ShutdownRegistry,
  timeoutMs: number,
  diagnostic: (code: string, moduleId: string) => void
): void {
  let shutdownFlow: Promise<void> | undefined

  const startShutdown = (): Promise<void> => {
    if (shutdownFlow === undefined) {
      shutdownFlow = registry.run({ timeoutMs, diagnostic }).then(() => {
        electronApp.exit(0)
      })
    }
    return shutdownFlow
  }

  const guardQuit = (event: PreventableQuitEvent): void => {
    event.preventDefault()
    void startShutdown()
  }

  electronApp.on('before-quit', guardQuit)
  electronApp.on('will-quit', guardQuit)
}
