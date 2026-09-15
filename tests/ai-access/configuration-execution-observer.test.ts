import { describe, expect, it, vi } from 'vitest'
import { createConfigurationExecutionObserver } from '../../app/main/ai-access/configuration-execution-observer'
import { createDeepSeekAdapters, observedConfigurationExecution } from '../../app/main/ai-access/adapters'
import type { ManagedTextFile } from '../../app/main/ai-access/deepseek-config'
import { defaultRecipes } from '../../app/main/recipes/recipes'
import { ShellInventory } from '../../app/main/shells/inventory'

function absentCommand(): never {
  throw Object.assign(new Error('absent'), { code: 1 })
}

function files() {
  const data = new Map<string, string>()
  const io: ManagedTextFile = {
    read: async path => data.get(path),
    write: async (path, contents) => { data.set(path, contents) },
    remove: async path => { data.delete(path) },
    withConfigWriteLock: async (_path, task) => task()
  }
  return { data, io }
}

describe('配置生效观察器', () => {
  it('只把已知原生进程的配置启动参数变成脱敏阻断事实', async () => {
    const secret = 'sk-process-argument-must-not-leave-observer'
    const observer = createConfigurationExecutionObserver({
      platform: 'darwin', home: '/customer', policyFilePresence: async () => 'absent',
      run: async (command) => {
        if (command === '/bin/ps') return [
          `/Applications/ChatGPT.app/Contents/Resources/codex exec --config model_provider=third-party ${secret}`,
          '/customer/.local/share/claude/versions/2.1.270 --settings /private/company.json',
          '/customer/.hermes/hermes-agent/venv/bin/hermes --provider custom'
        ].join('\n')
        if (command === '/usr/bin/profiles') return ''
        return absentCommand()
      }
    })

    const observed = await observer()

    expect(observed).toEqual({
      codex: { source: 'observed', commandLine: true },
      claude: { source: 'observed', commandLine: true },
      hermes: { source: 'observed', commandLine: true }
    })
    expect(JSON.stringify(observed)).not.toContain(secret)
    expect(JSON.stringify(observed)).not.toContain('/private/company.json')
  })

  it('Claude 受管文件和系统策略会阻断，策略探测异常则只给该壳 unknown', async () => {
    const managed = createConfigurationExecutionObserver({
      platform: 'darwin', home: '/customer',
      policyFilePresence: async path => path.includes('ClaudeCode') ? 'present' : 'absent',
      run: async (command) => command === '/bin/ps' || command === '/usr/bin/profiles' ? '' : absentCommand()
    })
    await expect(managed()).resolves.toEqual({ claude: { source: 'observed', managed: true } })

    const unreadable = createConfigurationExecutionObserver({
      platform: 'linux', home: '/customer',
      policyFilePresence: async path => path.includes('claude-code') ? 'unknown' : 'absent',
      run: async () => ''
    })
    await expect(unreadable()).resolves.toEqual({ claude: { source: 'unknown' } })
  })

  it('不能读取进程事实时不假定默认用户根，而是让三壳都进入未知启动上下文', async () => {
    const observer = createConfigurationExecutionObserver({
      platform: 'linux', home: '/customer', policyFilePresence: async () => 'absent',
      run: async command => command === '/usr/bin/profiles' ? '' : (() => { throw new Error('ps unavailable') })()
    })
    await expect(observer()).resolves.toEqual({
      codex: { source: 'unknown' }, claude: { source: 'unknown' }, hermes: { source: 'unknown' }
    })
  })

  it('正在运行但看不到继承环境的原生客户端也不猜默认根', async () => {
    const observer = createConfigurationExecutionObserver({
      platform: 'darwin', home: '/customer', policyFilePresence: async () => 'absent',
      run: async command => command === '/bin/ps'
        ? '/Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://'
        : command === '/usr/bin/profiles' ? '' : absentCommand()
    })
    await expect(observer()).resolves.toEqual({ codex: { source: 'unknown' } })
  })

  it('普通 defaults 偏好即使存在也不能被误判为受管策略', async () => {
    const calls: string[] = []
    const observer = createConfigurationExecutionObserver({
      platform: 'darwin', home: '/customer', policyFilePresence: async () => 'absent',
      run: async command => {
        calls.push(command)
        if (command === '/usr/bin/profiles' || command === '/bin/ps') return ''
        throw new Error('unexpected command')
      }
    })
    await expect(observer()).resolves.toEqual({})
    expect(calls).not.toContain('/usr/bin/defaults')
  })

  it('macOS 配置描述文件中出现官方受管域时才阻断对应壳', async () => {
    const calls: Array<readonly string[]> = []
    const observer = createConfigurationExecutionObserver({
      platform: 'darwin', home: '/customer', policyFilePresence: async () => 'absent',
      run: async (command, args) => {
        if (command === '/usr/bin/profiles') {
          calls.push(args)
          // The profile identifier is deliberately unrelated. The managed domain appears only
          // in the XML payload, as it does for a normal MDM ManagedClient preference payload.
          return '<plist><dict><key>PayloadIdentifier</key><string>company.policy.981</string><string>com.anthropic.claudecode</string><string>com.openai.codex</string></dict></plist>'
        }
        return command === '/bin/ps' ? '' : absentCommand()
      }
    })
    await expect(observer()).resolves.toEqual({
      codex: { source: 'observed', managed: true },
      claude: { source: 'observed', managed: true }
    })
    expect(calls).toEqual([['show', '-type', 'configuration', '-output', 'stdout-xml']])
  })

  it('Finder 打开的工具箱也只读识别终端启动文件里的单一配置根，并写入该根', async () => {
    const f = files()
    const observer = createConfigurationExecutionObserver({
      platform: 'darwin', home: '/customer', policyFilePresence: async () => 'absent',
      readStartupFile: async path => path.endsWith('.zshenv') ? 'export CODEX_HOME="$HOME/terminal-codex"\n' : undefined,
      run: async command => command === '/usr/bin/profiles' || command === '/bin/ps' ? '' : absentCommand()
    })
    const codex = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, observeConfigurationExecution: observer
    }).find(adapter => adapter.shell === 'codex')!

    await expect(codex.codexOfficialLoginRoot!()).resolves.toBe('/customer/terminal-codex')
    await codex.applyDeepSeek('sk-fixture-key-for-startup-root')

    expect(f.data.has('/customer/.codex/config.toml')).toBe(false)
    expect(f.data.get('/customer/terminal-codex/config.toml')).toContain('model_provider')
    await expect(codex.configurationTargetStatus!()).resolves.toEqual({
      shell: 'codex', scope: 'user', override: 'none', writable: true
    })
  })

  it('主进程观察到的三个重定向配置根会穿过复查并成为实际写入根', async () => {
    const f = files()
    const settings = new Map<string, string | undefined>()
    const runHermes = vi.fn(async (_command: string, args: readonly string[]) => {
      const key = args[2]
      if (key === undefined) throw new Error('fixture Hermes setting key is missing')
      if (args[1] === 'set') settings.set(key, args[3])
      else if (args[1] === 'unset') settings.delete(key)
    })
    const environment = new ShellInventory({
      platform: 'darwin', home: '/customer', recipes: () => defaultRecipes,
      env: {
        PATH: '/usr/bin:/bin',
        CODEX_HOME: '/customer/moved/codex',
        CLAUDE_CONFIG_DIR: '/customer/moved/claude',
        HERMES_HOME: '/customer/moved/hermes'
      }
    }).environment()
    const observed = observedConfigurationExecution('/customer', 'darwin', environment)
    const observer = createConfigurationExecutionObserver({
      platform: 'darwin', home: '/customer', policyFilePresence: async () => 'absent',
      readStartupFile: async () => undefined,
      run: async command => command === '/usr/bin/profiles' || command === '/bin/ps' ? '' : absentCommand()
    })
    const adapters = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      configurationExecution: observed, observeConfigurationExecution: observer,
      findHermesCommand: async () => '/customer/moved/hermes/hermes-agent/venv/bin/hermes',
      runHermes, readHermesConfig: async (_command, key) => settings.get(key)
    })

    await adapters.find(adapter => adapter.shell === 'codex')!.applyDeepSeek('sk-fixture-observed-root-codex')
    await adapters.find(adapter => adapter.shell === 'claude')!.applyDeepSeek('sk-fixture-observed-root-claude')
    await adapters.find(adapter => adapter.shell === 'hermes')!.applyDeepSeek('sk-fixture-observed-root-hermes')

    expect(f.data.has('/customer/.codex/config.toml')).toBe(false)
    expect(f.data.has('/customer/.claude/settings.json')).toBe(false)
    expect(f.data.has('/customer/.hermes/.env')).toBe(false)
    expect(f.data.get('/customer/moved/codex/config.toml')).toContain('model_provider')
    expect(f.data.get('/customer/moved/claude/settings.json')).toContain('https://api.deepseek.com/anthropic')
    expect(f.data.get('/customer/moved/hermes/.env')).toContain('DEEPSEEK_API_KEY=sk-fixture-observed-root-hermes')
    expect(runHermes).toHaveBeenCalledWith(
      '/customer/moved/hermes/hermes-agent/venv/bin/hermes',
      ['config', 'set', 'model.provider', 'deepseek'],
      '/customer/moved/hermes'
    )
  })

  it('多个或无法静态解析的启动根会阻断，而不猜默认目录', async () => {
    const f = files()
    const observer = createConfigurationExecutionObserver({
      platform: 'darwin', home: '/customer', policyFilePresence: async () => 'absent',
      readStartupFile: async path => path.endsWith('.zshenv') ? 'export CODEX_HOME=$CUSTOM_ROOT\n' : undefined,
      run: async command => command === '/usr/bin/profiles' || command === '/bin/ps' ? '' : absentCommand()
    })
    const codex = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, observeConfigurationExecution: observer
    }).find(adapter => adapter.shell === 'codex')!

    await expect(codex.applyDeepSeek('sk-fixture-key-for-unknown-root')).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    expect(f.data.size).toBe(0)
    await expect(codex.configurationTargetStatus!()).resolves.toMatchObject({
      scope: 'unknown', override: 'unknown', writable: false
    })
  })

  it.each([
    ['条件分支', 'if [ "$TERM_PROGRAM" = iTerm ]; then\n  export CODEX_HOME="$HOME/terminal-codex"\nfi\n'],
    ['函数作用域', 'configure_codex() {\n  export CODEX_HOME="$HOME/terminal-codex"\n}\n'],
    ['逻辑组合块', '[[ "$TERM_PROGRAM" = iTerm ]] && {\n  export CODEX_HOME="$HOME/terminal-codex"\n}\n'],
    ['子 shell', '(\n  export CODEX_HOME="$HOME/terminal-codex"\n)\n'],
    ['赋值后的逻辑运算', 'export CODEX_HOME="$HOME/terminal-codex" && echo configured\n'],
    ['source 动态加载', 'source "$HOME/.toolbox-roots"\nexport CODEX_HOME="$HOME/terminal-codex"\n'],
    ['带命令前缀的 source 动态加载', 'builtin source "$HOME/.toolbox-roots"\nexport CODEX_HOME="$HOME/terminal-codex"\n'],
    ['eval 动态加载', 'eval "$TOOLBOX_ROOTS"\nexport CODEX_HOME="$HOME/terminal-codex"\n'],
    ['未展开的主机变量', 'export CODEX_HOME="$HOME/.config/$HOSTNAME/codex"\n'],
    ['未引号 glob', 'export CODEX_HOME=$HOME/.codex-*\n']
  ])('遇到%s的启动根时阻断写入，不能把它当成所有启动环境的有效根', async (_label, contents) => {
    const f = files()
    const observer = createConfigurationExecutionObserver({
      platform: 'darwin', home: '/customer', policyFilePresence: async () => 'absent',
      readStartupFile: async path => path.endsWith('.zshenv') ? contents : undefined,
      run: async command => command === '/usr/bin/profiles' || command === '/bin/ps' ? '' : absentCommand()
    })
    const codex = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, observeConfigurationExecution: observer
    }).find(adapter => adapter.shell === 'codex')!

    await expect(codex.applyDeepSeek('sk-fixture-key-for-conditional-root')).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    expect(f.data.size).toBe(0)
    await expect(codex.configurationTargetStatus!()).resolves.toMatchObject({
      scope: 'unknown', override: 'unknown', writable: false
    })
  })

  it('工具箱自身环境和终端启动根不一致时阻断，避免对其中一个作假成功', async () => {
    const f = files()
    const observer = createConfigurationExecutionObserver({
      platform: 'darwin', home: '/customer', policyFilePresence: async () => 'absent',
      readStartupFile: async path => path.endsWith('.zshenv') ? 'export CLAUDE_CONFIG_DIR=/terminal/.claude\n' : undefined,
      run: async command => command === '/usr/bin/profiles' || command === '/bin/ps' ? '' : absentCommand()
    })
    const claude = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io,
      configurationExecution: { claude: { source: 'observed', userConfigPath: '/finder/.claude/settings.json' } },
      observeConfigurationExecution: observer
    }).find(adapter => adapter.shell === 'claude')!

    await expect(claude.applyDeepSeek('sk-fixture-key-for-root-mismatch')).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    expect(f.data.size).toBe(0)
  })

  it('检测到 HERMES_HOME 后，配置文件和受控官方启动器使用同一个根', async () => {
    const f = files()
    const settings = new Map<string, string | undefined>()
    const runHermes = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[1] === 'set') settings.set(args[2], args[3])
      else settings.delete(args[2])
    })
    const observer = createConfigurationExecutionObserver({
      platform: 'darwin', home: '/customer', policyFilePresence: async () => 'absent',
      readStartupFile: async path => path.endsWith('.zshenv') ? 'set -gx HERMES_HOME ~/terminal-hermes\n' : undefined,
      run: async command => command === '/usr/bin/profiles' || command === '/bin/ps' ? '' : absentCommand()
    })
    const hermes = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, observeConfigurationExecution: observer,
      findHermesCommand: async () => '/customer/terminal-hermes/hermes-agent/venv/bin/hermes',
      runHermes,
      readHermesConfig: async (_command, key) => settings.get(key)
    }).find(adapter => adapter.shell === 'hermes')!

    await hermes.applyDeepSeek('sk-fixture-key-for-hermes-startup-root')

    expect(f.data.has('/customer/.hermes/.env')).toBe(false)
    expect(f.data.get('/customer/terminal-hermes/.env')).toContain('DEEPSEEK_API_KEY')
    expect(runHermes).toHaveBeenCalledWith(
      '/customer/terminal-hermes/hermes-agent/venv/bin/hermes', ['config', 'set', 'model.provider', 'deepseek'], '/customer/terminal-hermes'
    )
  })

  it('Windows 只调用固定系统工具；活动客户端无法读取参数时阻断而不猜配置根', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const observer = createConfigurationExecutionObserver({
      platform: 'win32', home: 'C:\\Users\\customer', policyFilePresence: async () => 'absent',
      run: async (command, args) => {
        calls.push({ command, args })
        if (command.endsWith('tasklist.exe')) return args.includes('IMAGENAME eq codex.exe') ? '"codex.exe","1"' : 'INFO: No tasks'
        return absentCommand()
      }
    })
    const observed = await observer()
    expect(observed).toEqual({ codex: { source: 'unknown' } })
    expect(calls.filter(call => call.command.endsWith('tasklist.exe')).every(call => call.command === 'C:\\Windows\\System32\\tasklist.exe')).toBe(true)
    expect(calls.some(call => call.command.includes('Users\\customer'))).toBe(false)
  })

  it('同一个适配器在后续观察到受管策略后立即禁止写入，也不覆盖现有配置', async () => {
    const f = files()
    let managed = false
    const observe = vi.fn(async () => managed ? { claude: { source: 'observed' as const, managed: true } } : {})
    const claude = createDeepSeekAdapters({
      home: '/customer', platform: 'darwin', file: f.io, observeConfigurationExecution: observe
    }).find(adapter => adapter.shell === 'claude')!

    await claude.applyDeepSeek('sk-fixture-key-for-configuration-observer')
    const before = f.data.get('/customer/.claude/settings.json')
    managed = true

    await expect(claude.configurationTargetStatus!()).resolves.toMatchObject({ scope: 'unknown', override: 'managed', writable: false })
    await expect(claude.applyDeepSeek('sk-different-fixture-key')).rejects.toThrow('AI_ACCESS_CONFIGURATION_TARGET_BLOCKED')
    expect(f.data.get('/customer/.claude/settings.json')).toBe(before)
  })
})
