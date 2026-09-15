import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, defaultRecipes, findIncompatibility, peakState, readRecipeManifest, resolveProviderRoute, validRecipes } from '../../app/main/recipes/recipes'
import { RecipeStore } from '../../app/main/recipes/store'
import { modelProviderIds, modelProviders } from '../../app/shared/model-providers'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const envelope = (recipes: unknown, key = keys.privateKey) => {
  const payload = Buffer.from(JSON.stringify(recipes))
  return JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') })
}

describe('配方', () => {
  it('内置默认配方本身合法；篡改与错签被拒', () => {
    expect(validRecipes(defaultRecipes)).toBe(true)
    expect(readRecipeManifest(envelope(defaultRecipes), publicKey)).toEqual(defaultRecipes)
    const other = generateKeyPairSync('ed25519').privateKey
    expect(() => readRecipeManifest(envelope(defaultRecipes, other), publicKey)).toThrow('RECIPES_SIGNATURE_INVALID')
    const bad = { ...defaultRecipes, providers: { deepseek: { endpoints: { codex: 'http://evil.example/' } } } }
    expect(() => readRecipeManifest(envelope(bad), publicKey)).toThrow('RECIPES_INVALID')
    const badShell = { ...defaultRecipes, shells: { ...defaultRecipes.shells, codex: { ...defaultRecipes.shells.codex, command: 'rm -rf' } } }
    expect(validRecipes(badShell)).toBe(false)
  })

  it('壳版本闸门只拦精确版本与受影响服务商', () => {
    expect(findIncompatibility(defaultRecipes, 'claude', 'v2.1.154', 'deepseek')?.message).toContain('等待官方修复版本')
    expect(findIncompatibility(defaultRecipes, 'claude', '2.1.153', 'deepseek')).toBeUndefined()
    expect(findIncompatibility(defaultRecipes, 'codex', '2.1.154')).toBeUndefined()
    const scoped = { ...defaultRecipes, incompatibilities: [{ shell: 'codex' as const, versions: ['1.0.0'], providers: ['kimi' as const], message: 'x' }] }
    expect(findIncompatibility(scoped, 'codex', '1.0.0', 'deepseek')).toBeUndefined()
    expect(findIncompatibility(scoped, 'codex', '1.0.0', 'kimi')).toBeDefined()
  })

  it('DeepSeek 高峰：工作日 9–12 / 14–18 北京时间为高峰，其余半价', () => {
    const at = (iso: string) => peakState(defaultRecipes, 'deepseek', new Date(iso))
    expect(at('2026-09-14T02:30:00Z')).toMatchObject({ peak: true })   // 周一 10:30 北京
    expect(at('2026-09-14T04:30:00Z')).toMatchObject({ peak: false })  // 周一 12:30
    expect(at('2026-09-14T08:00:00Z')).toMatchObject({ peak: true })   // 周一 16:00
    expect(at('2026-09-13T02:30:00Z')).toMatchObject({ peak: false })  // 周日
    expect(peakState(defaultRecipes, 'zhipu')).toBeNull()
  })

  // 校验放行跨零点区间（只查 HH:MM 形状），比较却是 `minutes >= 起 && minutes < 止`——
  // `22:00-06:00` 于是恒为 false，运营一配夜间高峰就会静默变成「全天空闲、半价」。
  it('高峰时段跨零点：零点后那半段算前一天那条区间，⛔ 恒判空闲', () => {
    const night = { ...defaultRecipes, peakHours: { deepseek: { ...defaultRecipes.peakHours.deepseek, timezone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5], ranges: [['22:00', '06:00']] as const, peakLabel: '高峰', offPeakLabel: '空闲' } } }
    expect(validRecipes(night)).toBe(true)
    const at = (iso: string) => peakState(night, 'deepseek', new Date(iso))
    expect(at('2026-09-14T14:00:00Z')).toMatchObject({ peak: true })   // 周一 22:00 北京：区间起点
    expect(at('2026-09-14T18:00:00Z')).toMatchObject({ peak: true })   // 周二 02:00：周一那条区间的后半段
    expect(at('2026-09-14T04:00:00Z')).toMatchObject({ peak: false })  // 周一 12:00：区间外
    expect(at('2026-09-18T18:00:00Z')).toMatchObject({ peak: true })   // 周六 02:00：周五夜里那条，算数
    expect(at('2026-09-19T18:00:00Z')).toMatchObject({ peak: false })  // 周日 02:00：前一天周六不在名单里
    expect(at('2026-09-19T15:00:00Z')).toMatchObject({ peak: false })  // 周六 23:00：周六本身不在名单里
  })

  it('版本比较', () => {
    expect(compareVersions('2.1.154', '2.1.153')).toBe(1)
    expect(compareVersions('v0.153.4', '0.153.4')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('abc', '1.0.0')).toBe(0)
    // 预发布号原来被拆成 NaN 段、一律返回 0。2026-09-12 实查 npm：`@deepseek-ai/dsh` 的 latest 就是
    // `0.1.5-rc.1`，恒 0 意味着 DeepSeek Harness 装哪版都不提示更新、还被写成「已是最新」。
    expect(compareVersions('0.1.5-rc.1', '0.1.4')).toBe(1)
    expect(compareVersions('2.1.155', '2.1.154-beta')).toBe(1)
    // semver：同号的预发布版排在正式版之前；预发布段之间数字比数值、数字段小于文字段。
    expect(compareVersions('2.1.154-beta', '2.1.154')).toBe(-1)
    expect(compareVersions('0.1.5-rc.2', '0.1.5-rc.1')).toBe(1)
    expect(compareVersions('0.1.5-rc.10', '0.1.5-rc.2')).toBe(1)
    expect(compareVersions('0.1.5-rc.1', '0.1.5-rc.1')).toBe(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1)
    // 构建元数据不参与比较。
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0)
  })

  it('配方存取：缓存验签、后台更高版本落盘、坏响应保持现状', async () => {
    const root = await mkdtemp(join(tmpdir(), 'toolbox-recipes-'))
    try {
      const newer = { ...defaultRecipes, version: defaultRecipes.version + 1, shells: { ...defaultRecipes.shells, codex: { ...defaultRecipes.shells.codex, latest: '9.9.9' } } }
      let body = envelope(newer), status = 200
      const fetchImpl = (async () => new Response(body, { status })) as unknown as typeof fetch
      const store = new RecipeStore({ file: join(root, 'r.json'), publicKey, origin: 'https://updates.example/AI-tools/', fetch: fetchImpl })
      expect((await store.load()).version).toBe(defaultRecipes.version)
      expect(await store.refresh(1)).toBe(true)
      expect(store.current().shells.codex.latest).toBe('9.9.9')
      const reopened = new RecipeStore({ file: join(root, 'r.json'), publicKey, origin: 'https://updates.example/AI-tools/', fetch: fetchImpl })
      expect((await reopened.load()).version).toBe(newer.version)
      body = 'garbage'; status = 200
      expect(await reopened.refresh(10_000_000)).toBe(false)
      expect(reopened.current().version).toBe(newer.version)
      status = 404
      expect(await reopened.refresh(20_000_000)).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('回滚保护：签名合法但 updatedAt 更旧的旧配方拒用，现配方保持不变', async () => {
    const root = await mkdtemp(join(tmpdir(), 'toolbox-recipes-rollback-'))
    try {
      // 日期跟着内置配方走：内置 updatedAt 一改，硬编码日期会让这条无关地红（09-13 换 Kimi 默认模型时踩过）。
      const today = defaultRecipes.updatedAt
      const current = { ...defaultRecipes, version: defaultRecipes.version + 2, updatedAt: today, shells: { ...defaultRecipes.shells, codex: { ...defaultRecipes.shells.codex, latest: '3.0.0' } } }
      let body = envelope(current), status = 200
      const fetchImpl = (async () => new Response(body, { status })) as unknown as typeof fetch
      const store = new RecipeStore({ file: join(root, 'r.json'), publicKey, origin: 'https://updates.example/AI-tools/', fetch: fetchImpl })
      expect(await store.refresh(1)).toBe(true)
      expect(store.current().updatedAt).toBe(today)
      // 更高版本号但日期更旧的旧缓存：拒用
      body = envelope({ ...current, version: current.version + 1, updatedAt: '2026-09-05' })
      expect(await store.refresh(10_000_000)).toBe(false)
      expect(store.current().version).toBe(current.version)
      expect(store.current().shells.codex.latest).toBe('3.0.0')
      // 同日期更高版本重发：接受
      body = envelope({ ...current, version: current.version + 1, updatedAt: today })
      expect(await store.refresh(20_000_000)).toBe(true)
      expect(store.current().version).toBe(current.version + 1)
      // 全新客户端（尚未下载过配方）也不会被旧日期的缓存拖回过去
      const fresh = new RecipeStore({ file: join(root, 'fresh.json'), publicKey, origin: 'https://updates.example/AI-tools/', fetch: fetchImpl })
      body = envelope({ ...defaultRecipes, version: defaultRecipes.version + 1, updatedAt: '2026-09-05' })
      status = 200
      expect(await fresh.refresh(1)).toBe(false)
      expect(fresh.current().updatedAt).toBe(defaultRecipes.updatedAt)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('内置配方比线上新时，线上的旧版本号顶不掉它（客户端升级带上来的 v3 ⛔ 被线上 v2 拖回去）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'toolbox-recipes-builtin-'))
    try {
      // 新装的客户端手里是内置配方（现在是 v3），线上还停在 v2、日期一样新（绕得过日期那道闸）。
      // 原来「当前是内置配方就照单全收」的写法会让线上 v2 把内置 v3 顶掉。
      expect(defaultRecipes.version).toBeGreaterThan(2)
      const online = { ...defaultRecipes, version: 2, shells: { ...defaultRecipes.shells, codex: { ...defaultRecipes.shells.codex, latest: '1.0.0' } } }
      const fetchImpl = (async () => new Response(envelope(online), { status: 200 })) as unknown as typeof fetch
      const store = new RecipeStore({ file: join(root, 'r.json'), publicKey, origin: 'https://updates.example/AI-tools/', fetch: fetchImpl })
      expect(store.current()).toBe(defaultRecipes)
      expect(await store.refresh(1)).toBe(false)
      expect(store.current().version).toBe(defaultRecipes.version)
      expect(store.current().shells.codex.latest).toBe(defaultRecipes.shells.codex.latest)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  // `load()` 原来只比版本号（`>=`）：同版本号的旧缓存照样顶掉内置配方，而 `refresh()` 同版本又不换，
  // 要等后台升版本号才修得回来。下次改内置内容忘了升版本号，老客户就会一直用旧配方。
  it('同版本号但更旧的本机缓存顶不掉内置配方，后台同版本也能把它换回来', async () => {
    const root = await mkdtemp(join(tmpdir(), 'toolbox-recipes-stale-'))
    try {
      const file = join(root, 'r.json')
      const stale = { ...defaultRecipes, updatedAt: '2026-09-01', providers: {}, shells: { ...defaultRecipes.shells, codex: { ...defaultRecipes.shells.codex, latest: '0.0.1' } } }
      expect(validRecipes(stale)).toBe(true)
      await writeFile(file, JSON.stringify({ manifest: envelope(stale) }))
      const online = { ...defaultRecipes, shells: { ...defaultRecipes.shells, codex: { ...defaultRecipes.shells.codex, latest: '9.9.9' } } }
      const fetchImpl = (async () => new Response(envelope(online), { status: 200 })) as unknown as typeof fetch
      const store = new RecipeStore({ file, publicKey, origin: 'https://updates.example/AI-tools/', fetch: fetchImpl })
      const loaded = await store.load()
      expect(loaded.updatedAt).toBe(defaultRecipes.updatedAt)
      expect(loaded.shells.codex.latest).toBe(defaultRecipes.shells.codex.latest)
      expect(loaded.providers.deepseek?.defaultModel).toBe(defaultRecipes.providers.deepseek?.defaultModel)
      // 内置没被顶掉，后台同版本（内容更全）这一拉就换得上，⛔ 要等升版本号。
      expect(await store.refresh(1)).toBe(true)
      expect(store.current().shells.codex.latest).toBe('9.9.9')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('同版本号但更新的本机缓存仍然采用（正常的后台升级路径 ⛔ 被上一条挡掉）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'toolbox-recipes-fresh-cache-'))
    try {
      const file = join(root, 'r.json')
      const fresher = { ...defaultRecipes, updatedAt: '2099-01-01', shells: { ...defaultRecipes.shells, codex: { ...defaultRecipes.shells.codex, latest: '8.8.8' } } }
      await writeFile(file, JSON.stringify({ manifest: envelope(fresher) }))
      const store = new RecipeStore({ file, publicKey, origin: 'https://updates.example/AI-tools/', fetch: (async () => new Response('', { status: 404 })) as unknown as typeof fetch })
      expect((await store.load()).shells.codex.latest).toBe('8.8.8')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('标准默认模型（配方 defaultModel）', () => {
  const withProvider = (override: Record<string, unknown>) => ({ ...defaultRecipes, providers: { deepseek: override } })
  const builtin = { endpoint: 'https://api.deepseek.com/responses', model: 'deepseek-v4-flash' }

  it('线上 v2 配方没有这个字段时行为不变，回落到客户端内置', () => {
    expect(validRecipes(defaultRecipes)).toBe(true)
    // 内置配方现已带 defaultModel（v3），「没有这个字段」要用 providers 为空的配方来验。
    expect(resolveProviderRoute({ ...defaultRecipes, providers: {} }, 'codex', 'deepseek', builtin)).toEqual(builtin)
    expect(resolveProviderRoute(withProvider({}) as never, 'codex', 'deepseek', builtin)).toEqual(builtin)
  })

  it('没有按壳覆盖时用这家的标准默认模型；有按壳覆盖时按壳的来', () => {
    expect(resolveProviderRoute(withProvider({ defaultModel: 'deepseek-v4-pro' }) as never, 'codex', 'deepseek', builtin))
      .toEqual({ endpoint: builtin.endpoint, model: 'deepseek-v4-pro' })
    expect(resolveProviderRoute(withProvider({ defaultModel: 'deepseek-v4-pro', models: { claude: 'deepseek-flash' } }) as never, 'claude', 'deepseek', builtin))
      .toEqual({ endpoint: builtin.endpoint, model: 'deepseek-flash' })
    expect(resolveProviderRoute(withProvider({ defaultModel: 'deepseek-v4-pro', models: { claude: 'deepseek-flash' } }) as never, 'codex', 'deepseek', builtin).model)
      .toBe('deepseek-v4-pro')
  })

  it('模型 ID 按同一条规则校验，⛔ 让引号换行之类的东西随配方下发', () => {
    expect(validRecipes(withProvider({ defaultModel: 'deepseek-v4-pro' }))).toBe(true)
    expect(validRecipes(withProvider({ defaultModel: 'bad"\nmodel_provider="evil' }))).toBe(false)
    expect(validRecipes(withProvider({ defaultModel: 42 }))).toBe(false)
  })

  it('内置配方覆盖每个客户产品，默认模型不沿用已废弃的 GLM-5.3 选择', () => {
    for (const provider of modelProviderIds) expect(defaultRecipes.providers[provider]?.defaultModel).toBeTruthy()
    expect(defaultRecipes.providers['zhipu-api']?.defaultModel).toBe('glm-5.3-flash')
    expect(defaultRecipes.providers.zhipu?.defaultModel).toBe('glm-5.3-flash')
    expect(defaultRecipes.providers.moonshot?.defaultModel).toBe(modelProviders.moonshot.models.codex)
    expect(defaultRecipes.providers.kimi?.defaultModel).toBe(modelProviders.kimi.models.codex)
    expect(defaultRecipes.providers.deepseek?.defaultModel).toBe('deepseek-flash')
  })
})
