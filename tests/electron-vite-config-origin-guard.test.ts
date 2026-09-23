import { afterEach, describe, expect, it } from 'vitest'
import defineElectronViteConfig from '../electron.vite.config'

type ConfigEnv = { command: 'build' | 'serve'; mode: string }

const originEnv = 'https://laixin.work/'

/** 09-19 凌晨事故防再犯（N-24 验收遗留）：packaged 构建注入空 TOOLBOX_ACCOUNT_ORIGIN 必须在
 *  构建期当场炸——包内账号后台为空、客户注册/登录全部 ACCOUNT_NOT_CONFIGURED,发了才抓得住。
 *  dev 空跑仅认显式 TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN=1。真值表钉死,⛔ 只豁免 serve。 */
describe('electron.vite.config.ts 账号 origin 构建守卫', () => {
  const saved = { origin: process.env.TOOLBOX_ACCOUNT_ORIGIN, update: process.env.TOOLBOX_UPDATE_ORIGIN, allow: process.env.TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN }

  afterEach(() => {
    if (saved.origin === undefined) delete process.env.TOOLBOX_ACCOUNT_ORIGIN
    else process.env.TOOLBOX_ACCOUNT_ORIGIN = saved.origin
    if (saved.update === undefined) delete process.env.TOOLBOX_UPDATE_ORIGIN
    else process.env.TOOLBOX_UPDATE_ORIGIN = saved.update
    if (saved.allow === undefined) delete process.env.TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN
    else process.env.TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN = saved.allow
  })

  function configFor(env: ConfigEnv) {
    return (defineElectronViteConfig as unknown as (env: ConfigEnv) => unknown)(env)
  }

  it('packaged 构建(command=build)不带 origin 直接抛错', () => {
    delete process.env.TOOLBOX_ACCOUNT_ORIGIN
    delete process.env.TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN
    expect(() => configFor({ command: 'build', mode: 'production' })).toThrowError(/TOOLBOX_ACCOUNT_ORIGIN/)
  })

  it('packaged 构建带 origin 通过,且 define 注入的就是该 origin', () => {
    process.env.TOOLBOX_ACCOUNT_ORIGIN = originEnv
    process.env.TOOLBOX_UPDATE_ORIGIN = originEnv
    delete process.env.TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN
    const config = configFor({ command: 'build', mode: 'production' }) as {
      main: { define: Record<string, string> }
    }
    expect(config.main.define.__TOOLBOX_ACCOUNT_ORIGIN__).toBe(JSON.stringify(originEnv))
  })

  it('dev(serve)不带 origin 且无放行 flag 也抛错——空跑必须显式认账', () => {
    delete process.env.TOOLBOX_ACCOUNT_ORIGIN
    delete process.env.TOOLBOX_UPDATE_ORIGIN
    delete process.env.TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN
    expect(() => configFor({ command: 'serve', mode: 'development' })).toThrowError(/TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN/)
  })

  it('dev(serve)带 TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN=1 放行(空 origin)', () => {
    delete process.env.TOOLBOX_ACCOUNT_ORIGIN
    delete process.env.TOOLBOX_UPDATE_ORIGIN
    process.env.TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN = '1'
    expect(() => configFor({ command: 'serve', mode: 'development' })).not.toThrow()
  })

  it('放行 flag 救不了 packaged 构建——build+空 origin+flag=1 仍抛错', () => {
    delete process.env.TOOLBOX_ACCOUNT_ORIGIN
    delete process.env.TOOLBOX_UPDATE_ORIGIN
    process.env.TOOLBOX_ALLOW_EMPTY_ACCOUNT_ORIGIN = '1'
    expect(() => configFor({ command: 'build', mode: 'production' })).toThrowError(/TOOLBOX_ACCOUNT_ORIGIN/)
  })

  it('packaged 构建拒绝账号与更新指向不同站点，防止域名迁移后混装', () => {
    process.env.TOOLBOX_ACCOUNT_ORIGIN = originEnv
    process.env.TOOLBOX_UPDATE_ORIGIN = 'https://laixin.net.cn/AI-tools/'
    expect(() => configFor({ command: 'build', mode: 'production' })).toThrowError(/TOOLBOX_UPDATE_ORIGIN 与 TOOLBOX_ACCOUNT_ORIGIN 不一致/)
  })
})
