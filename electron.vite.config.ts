import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { developmentCsp, productionCsp } from './app/renderer/src/csp'

const root = __dirname

export default defineConfig(({ command }) => ({
  main: {
    define: { __TOOLBOX_ACCOUNT_ORIGIN__: JSON.stringify(process.env.TOOLBOX_ACCOUNT_ORIGIN ?? ''),
      __TOOLBOX_UPDATE_ORIGIN__: JSON.stringify(process.env.TOOLBOX_UPDATE_ORIGIN ?? 'https://laixin.net.cn/AI-tools/'),
      __TOOLBOX_GITHUB_REPOSITORY__: JSON.stringify(process.env.TOOLBOX_GITHUB_REPOSITORY ?? 'pingxia710/laixin-ai-toolbox'),
      __TOOLBOX_UPDATE_PUBLIC_KEY__: JSON.stringify(readFileSync(resolve(root, 'resources/update-public-key.pem'), 'utf8')) },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input:
          process.env.TOOLBOX_BRIDGE_PROBE === '1'
            ? {
                index: resolve(root, 'app/main/index.ts'),
                'bridge-probe': resolve(root, 'tests/electron/bridge-probe.ts')
              }
            : resolve(root, 'app/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [
      externalizeDepsPlugin(),
      validateUniqueLiteral('app/preload/api', 'namespace', 'PRELOAD_NAMESPACE_DUPLICATE')
    ],
    build: {
      rollupOptions: {
        input: resolve(root, 'app/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(root, 'app/renderer'),
    plugins: [
      validateUniqueLiteral('app/renderer/src/pages', 'moduleId', 'PAGE_MODULE_DUPLICATE'),
      {
        name: 'toolbox-csp',
        transformIndexHtml: (html) =>
          html.replace('__TOOLBOX_CSP__', command === 'serve' ? developmentCsp : productionCsp)
      }
    ],
    build: {
      rollupOptions: {
        input: resolve(root, 'app/renderer/index.html')
      }
    }
  }
}))

function validateUniqueLiteral(directory: string, property: string, errorCode: string): Plugin {
  return {
    name: `toolbox-${errorCode.toLowerCase()}`,
    buildStart() {
      const seen = new Map<string, string>()
      for (const entry of readdirSync(resolve(root, directory)).sort()) {
        if (!entry.endsWith('.ts')) {
          continue
        }
        const source = readFileSync(resolve(root, directory, entry), 'utf8')
        const value = literalProperty(source, property)
        if (value === undefined) {
          continue
        }
        const earlier = seen.get(value)
        if (earlier !== undefined) {
          this.error(`${errorCode}:${value}:${earlier}:${entry}`)
        }
        seen.set(value, entry)
      }
    }
  }
}

function literalProperty(source: string, property: string): string | undefined {
  const match = source.match(new RegExp(`\\b${property}\\s*[:=]\\s*['\"]([^'\"]+)['\"]`))
  return match?.[1]
}
