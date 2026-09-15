import { contextBridge } from 'electron'

interface PreloadModule {
  readonly namespace: string
  readonly api: object
}

export function collectPreloadApis(modules: Readonly<Record<string, unknown>>): Record<string, object> {
  const registered: Record<string, object> = {}
  for (const path of Object.keys(modules).sort()) {
    const candidate = modules[path]
    if (!isPreloadModule(candidate)) {
      throw new Error('PRELOAD_MODULE_INVALID')
    }
    if (Object.hasOwn(registered, candidate.namespace)) {
      throw new Error('PRELOAD_NAMESPACE_DUPLICATE')
    }
    registered[candidate.namespace] = candidate.api
  }
  return registered
}

function isPreloadModule(value: unknown): value is PreloadModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'namespace' in value &&
    typeof value.namespace === 'string' &&
    /^[a-z][a-z0-9]*$/.test(value.namespace) &&
    'api' in value &&
    typeof value.api === 'object' &&
    value.api !== null
  )
}

const discoveredModules = import.meta.glob(
  ['./api/*.ts', '!./api/index.ts', '!./api/*.test.ts'],
  { eager: true }
)
const electronProcess = process as NodeJS.Process & { readonly type?: string }

if (electronProcess.type === 'renderer') {
  contextBridge.exposeInMainWorld('toolbox', collectPreloadApis(discoveredModules))
}
