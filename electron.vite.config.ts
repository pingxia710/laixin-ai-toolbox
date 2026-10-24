import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { developmentCsp, productionCsp } from './app/renderer/src/csp'

const root = __dirname

/** 读白名单。JSON.parse 给出的是 any,**必须在这里收口成 string[]** ——
 *  ⛔ 让 any 流进 filter/map 的参数(typecheck 会红,而 electron-vite build 不做类型检查,
 *  只跑构建的验证碰不到它)。
 *
 *  **格式不对就抛错,⛔ 静默降级成空名单。** 缺字段和空数组当空(那是「本来就没有」),
 *  但 "hosts": "dl.laixin.net.cn" 这种写错、或数组里混进 null/数字,都要当场炸:
 *  静默变空的后果是「有人加完主机以为发出去了」,而白名单少认只会在**下次想挂 CDN 时**
 *  才暴露,那时得再发一版。构建期炸掉的代价,比发出去之后才发现小得多。 */
function readMirrorHosts(): string[] {
  const file = resolve(root, 'resources/update-mirror-hosts.json')
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const hosts = (parsed as { hosts?: unknown }).hosts
  if (hosts === undefined) return []
  if (!Array.isArray(hosts)) throw new Error(`${file}: hosts 必须是数组,现在是 ${typeof hosts}`)
  return hosts.map((host, i) => {
    if (typeof host !== 'string' || !host.trim()) throw new Error(`${file}: hosts[${i}] 不是非空字符串(${JSON.stringify(host)})`)
    return host.trim()
  })
}

function assertAccountOriginProvided(command: 'build' | 'serve'): string {
  const origin = process.env.TOOLBOX_ACCOUNT_ORIGIN ?? ''
  if (origin !== '') return origin
  // 09-19 凌晨事故防再犯（N-24 验收遗留）：packaged 构建漏注 origin 时包内账号后台为空,
  // 注册/登录全部 ACCOUNT_NOT_CONFIGURED,只有发出去之后靠回读门禁才抓得住——构建期当场炸。
  // dev 空跑属正常开发形态,但要显式 TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN=1 认账;packaged 无豁免。
  if (command === 'serve' && process.env.TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN === '1') return origin
  throw new Error(
    'TOOLBOX_ACCOUNT_ORIGIN 为空,拒绝构建:包内账号后台会是空串,客户注册/登录全部失败(09-19 事故)。' +
      '正式构建请设置 TOOLBOX_ACCOUNT_ORIGIN(如 https://laixin.work/);' +
      '仅 dev(electron-vite dev)可用 TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN=1 显式放行。'
  )
}

function resolveUpdateOrigin(accountOrigin: string, command: 'build' | 'serve'): string {
  const updateOrigin = process.env.TOOLBOX_UPDATE_ORIGIN || accountOrigin || 'https://laixin.work/'
  if (!accountOrigin || command === 'serve' && process.env.TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN === '1') return updateOrigin
  try {
    if (new URL(updateOrigin).href !== new URL(accountOrigin).href) throw new Error('mismatch')
  } catch {
    throw new Error(
      `TOOLBOX_UPDATE_ORIGIN 与 TOOLBOX_ACCOUNT_ORIGIN 不一致,拒绝构建:账号与更新会指向不同站点。` +
      `请统一设置为 https://laixin.work/ (当前 update=${updateOrigin}, account=${accountOrigin})`
    )
  }
  return updateOrigin
}

export default defineConfig(({ command }) => {
  const accountOrigin = assertAccountOriginProvided(command)
  const updateOrigin = resolveUpdateOrigin(accountOrigin, command)
  return {
  main: {
    define: { __TOOLBOX_ACCOUNT_ORIGIN__: JSON.stringify(accountOrigin),
      __TOOLBOX_UPDATE_ORIGIN__: JSON.stringify(updateOrigin),
      __TOOLBOX_GITHUB_REPOSITORY__: JSON.stringify(process.env.TOOLBOX_GITHUB_REPOSITORY ?? 'pingxia710/laixin-ai-toolbox'),
      // 白名单从**提交进仓库的文件**读,⛔ 环境变量 —— 事后必须能查出哪一版带了什么
      // (环境变量不留痕)。门禁 verify-mirrors-ready 靠 git show v<版本>:该文件 核。
      // 注入**数组字面量**,⛔ 逗号串 —— 串的写法在成品里会打包成
      // `"a,b".split(',').map(...)`,门禁没法从成品字节里读出白名单到底是什么。
      // 数组字面量让成品自己说得清:扫到 `mirrorHosts: [...]` 就是它。
      __TOOLBOX_UPDATE_MIRROR_HOSTS__: JSON.stringify(readMirrorHosts()),
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
  }
})

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
