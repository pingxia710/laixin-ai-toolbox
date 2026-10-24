// 配方存取：内置默认 → 本机缓存（已验签）→ 后台最新（验签后落盘）。
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultRecipes, readRecipeManifest, validRecipes, type Recipes } from './recipes'

export interface RecipeStoreOptions {
  readonly file: string
  readonly publicKey: string
  readonly origin: string
  readonly fetch?: typeof fetch
}

export class RecipeStore {
  private recipes: Recipes = defaultRecipes
  private loaded = false
  private lastFetchAt = 0
  constructor(private readonly options: RecipeStoreOptions) {}

  current(): Recipes { return this.recipes }

  async load(): Promise<Recipes> {
    if (this.loaded) return this.recipes
    this.loaded = true
    try {
      const cached = JSON.parse(await readFile(this.options.file, 'utf8')) as { manifest: string }
      if (typeof cached.manifest === 'string') {
        const recipes = readRecipeManifest(cached.manifest, this.options.publicKey)
        // 同版本号还要比日期：客户端升级可能改了内置内容却没升版本号，那时旧缓存会静默顶掉内置，
        // 而 refresh() 同版本又不换（:51），线上不升版本号就修不回来。日期解析不出来的一律当更旧。
        const newer = recipes.version > this.recipes.version ||
          (recipes.version === this.recipes.version && Date.parse(recipes.updatedAt) > Date.parse(this.recipes.updatedAt))
        if (newer) this.recipes = recipes
      }
    } catch { /* 没有缓存或缓存无效：用内置默认。 */ }
    return this.recipes
  }

  /** 从后台拉取最新配方；失败保持现状。返回是否更新。 */
  async refresh(now = Date.now()): Promise<boolean> {
    if (this.lastFetchAt && now - this.lastFetchAt < 60_000) return false
    this.lastFetchAt = now
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const url = new URL('updates/recipes.json', new URL(this.options.origin))
      const response = await (this.options.fetch ?? fetch)(url, { signal: controller.signal, redirect: 'error' })
      if (!response.ok) return false
      const body = await response.text()
      if (Buffer.byteLength(body) > 256 * 1024) return false
      const recipes = readRecipeManifest(body, this.options.publicKey)
      // 回滚保护：版本号更旧的一律拒，**⛔ 因为当前用的是内置配方就网开一面**——
      // 内置配方会随客户端升级往上走（v3），线上还停在 v2 时那样会被顶回旧版。
      if (recipes.version < this.recipes.version) return false
      // 同版本只在当前还是内置配方时才换：线上同版本带的内容更全，已经在用线上配方就不必重复换。
      if (recipes.version === this.recipes.version && this.recipes !== defaultRecipes) return false
      // CDN 旧缓存可能是签名合法但内容更旧的配方；比当前已用配方更旧的一律拒用。
      if (Date.parse(recipes.updatedAt) < Date.parse(this.recipes.updatedAt)) return false
      await mkdir(dirname(this.options.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.options.file}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify({ manifest: body }), { mode: 0o600 })
      await rename(temporary, this.options.file)
      this.recipes = recipes
      return true
    } catch { return false }
    finally { clearTimeout(timer) }
  }

  /** 测试注入用：直接替换当前配方。 */
  replace(recipes: unknown): void { if (validRecipes(recipes)) this.recipes = recipes }
}

export function recipeFile(userData: string): string { return join(userData, 'recipes', 'recipes.json') }
