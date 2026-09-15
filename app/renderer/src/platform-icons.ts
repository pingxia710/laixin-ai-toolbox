import codex from './assets/platforms/codex.svg?url'
import claude from './assets/platforms/claude-code.png?url'
import hermes from './assets/platforms/hermes.png?url'
import deepseek from './assets/platforms/deepseek-harness.svg?url'
import zcode from './assets/platforms/zcode.png?url'
import kimi from './assets/platforms/kimi-code.png?url'
import type { UsagePlatformId } from './tabs'
import './platform-icons.css'

const logos: Record<UsagePlatformId, string> = {
  codex, 'claude-code': claude, hermes, 'deepseek-harness': deepseek, zcode, 'kimi-code': kimi
}

export function platformIcon(platform: UsagePlatformId): HTMLImageElement {
  const image = document.createElement('img')
  image.src = logos[platform]
  image.alt = ''
  image.className = `platform-logo platform-logo-${platform}`
  image.width = 20
  image.height = 20
  image.draggable = false
  return image
}
