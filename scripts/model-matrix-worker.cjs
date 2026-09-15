// 在 Electron 下跑真实验证矩阵；由 scripts/model-matrix.mjs 启动，⛔ 直接跑。
// Key 是 Electron 的 safeStorage 加密存的，只有在 Electron 主进程里才解得开。
const { createRequire } = require('node:module')
const { readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { app, safeStorage } = require('electron')
const { finishMatrixWorker, fixedMatrixWorkerFailure } = require('./model-matrix-worker-output.cjs')

const ts = require('typescript')
require.extensions['.ts'] = (module, file) => module._compile(
  ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
void createRequire

const flag = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const fail = (reason) => { console.error(fixedMatrixWorkerFailure(reason)); app.exit(2) }

// 裸跑 Electron 时 app 名不是产品名：userData 会落到别处，safeStorage 的 Keychain 条目也会是「Electron Safe Storage」
// 而不是「<产品名> Safe Storage」，解不开真实工具箱存的 Key。所以在 ready 之前先把 app 名对齐产品名。
const productName = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).build.productName
app.setName(productName)

async function main() {
  await app.whenReady()
  const userData = flag('--user-data') ?? join(app.getPath('appData'), productName)
  app.setPath('userData', userData)
  // --keys-file <json>：直接从本机文件读 Key（{ deepseek, zhipuApi, zhipu, kimi(开放平台), kimiCode(套餐) }），不碰钥匙串。
  // 普通 API 与 Coding Plan 必须分别给 zhipuApi / zhipu；⛔ 因为名称相近就把一把 Key 复制到两个产品。
  const keysFile = flag('--keys-file')
  if (!keysFile && !safeStorage.isEncryptionAvailable()) {
    return fail('safe_storage_unavailable')
  }

  const { AiAccessService } = require('../app/main/ai-access/service.ts')
  const { AiGateway } = require('../app/main/ai-access/gateway.ts')
  const { createAiAccessStore } = require('../app/main/ai-access/store.ts')
  const { createDeepSeekAdapters } = require('../app/main/ai-access/adapters.ts')
  const { createManagedTextFile } = require('../app/main/ai-access/file.ts')
  const { ModelMatrixStore, createModelMatrixFiles } = require('../app/main/ai-access/model-matrix-store.ts')

  let store
  let state
  if (keysFile) {
    const raw = JSON.parse(readFileSync(resolve(keysFile), 'utf8'))
    const map = { deepseek: raw.deepseek, 'zhipu-api': raw.zhipuApi, zhipu: raw.zhipu, moonshot: raw.kimi, kimi: raw.kimiCode }
    const shellKeys = {}
    for (const shell of ['codex', 'claude', 'hermes']) {
      shellKeys[shell] = {}
      for (const [provider, key] of Object.entries(map)) if (typeof key === 'string' && key.trim()) shellKeys[shell][provider] = key.trim()
    }
    state = { version: 1, selected: {}, shellKeys }
    store = { read: async () => state, write: async (next) => { state = next } }
  }
  if (!store) store = createAiAccessStore(join(userData, 'ai-access'))
  if (!state) try { state = await store.read() } catch {
    return fail('state_unavailable')
  }
  const saved = Object.entries(state.shellKeys || {}).flatMap(([shell, keys]) => Object.keys(keys || {}).map((provider) => `${shell}/${provider}`))
  if (saved.length === 0) {
    return fail('key_missing')
  }

  // 和生产一样读本机已验签的配方与已装软件清单：矩阵要测客户真正会走的地址与模型。
  const { RecipeStore, recipeFile } = require('../app/main/recipes/store.ts')
  const { resolveProviderRoute } = require('../app/main/recipes/recipes.ts')
  const { trustedCliInstalled } = require('../app/main/shells/inventory.ts')
  const { modelProviders } = require('../app/shared/model-providers.ts')
  const recipes = new RecipeStore({
    file: recipeFile(userData),
    publicKey: readFileSync(join(__dirname, '..', 'resources/update-public-key.pem'), 'utf8'),
    origin: 'https://laixin.net.cn/AI-tools/' // 只用于联网取新配方，本脚本不取，只读本机缓存。
  })
  await recipes.load()
  const matrixStore = new ModelMatrixStore(createModelMatrixFiles(join(userData, 'model-matrix.json')))
  const service = new AiAccessService(store, createDeepSeekAdapters({
    home: app.getPath('home'), platform: process.platform, localAppData: process.env.LOCALAPPDATA,
    hermesHome: process.env.HERMES_HOME, file: createManagedTextFile()
  }), new AiGateway(), {
    saveMatrix: (report) => matrixStore.save(report),
    // A real-Key matrix must not call the generic installation probe: it runs PATH entries with
    // `--version`. Presence is enough here, and only fixed trusted candidates are considered.
    shellInstalled: async (software) => trustedCliInstalled(software === 'claude' ? 'claude-code' : software,
      process.platform, app.getPath('home'), process.env),
    resolveRoute: (software, provider) => resolveProviderRoute(recipes.current(), software, provider,
      { endpoint: modelProviders[provider].endpoints[software], model: modelProviders[provider].models[software] })
  })

  const output = flag('--json')
  await finishMatrixWorker(service, (line) => console.log(line), (code) => app.exit(code), report => {
    if (output) writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`)
  })
}

main().catch(() => fail('matrix_failed'))
