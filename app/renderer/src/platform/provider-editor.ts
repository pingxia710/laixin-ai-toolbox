import type { AiAccessApi } from '../../../preload/api/ai-access'
import type { ApiShell, ModelProviderId } from '../../../shared/api-service-types'
import { modelProviders } from '../../../shared/model-providers'
import { icon } from '../icons'
import { measureProviderLatency } from './provider-latency'

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), { textContent: text, className })
}

export function openProviderEditor(api: AiAccessApi, shell: ApiShell, provider: ModelProviderId, keySaved: boolean,
  save: (key: string | undefined, model: string) => Promise<{ ok: boolean; message: string; keySaved: boolean }>, restoreFocus: () => void): () => void {
  const dialog = node('dialog', '', 'api-service-dialog provider-editor')
  dialog.setAttribute('aria-label', `编辑 ${modelProviders[provider].title}`)
  const header = node('header', '', 'api-service-header')
  const close = node('button', '关闭', 'secondary-action'); close.type = 'button'
  close.onclick = () => dialog.close()
  header.append(node('h2', `编辑 ${modelProviders[provider].title}`), close)
  const form = node('form', '', 'provider-editor-form')
  const field = (label: string): HTMLInputElement => {
    const wrapper = node('label', label, 'provider-editor-field')
    const input = node('input'); input.type = 'text'; input.readOnly = true
    wrapper.append(input); form.append(wrapper); return input
  }
  const website = field('官网链接')
  const keyLabel = node('label', 'API Key', 'provider-editor-field')
  const keyRow = node('span', '', 'provider-editor-key')
  const key = node('input'); key.type = 'password'; key.name = 'key'; key.autocomplete = 'off'
  key.setAttribute('aria-label', 'API Key')
  key.minLength = 16; key.maxLength = 512; key.required = !keySaved
  key.placeholder = keySaved ? '已保存，留空沿用原 Key' : '输入此渠道的 API Key'
  const reveal = node('button', '', 'provider-editor-reveal'); reveal.type = 'button'
  reveal.setAttribute('aria-label', '显示本次输入的 API Key'); reveal.setAttribute('aria-pressed', 'false')
  reveal.append(icon('eye'))
  reveal.onclick = () => {
    const visible = key.type === 'password'; key.type = visible ? 'text' : 'password'
    reveal.setAttribute('aria-pressed', String(visible)); reveal.setAttribute('aria-label', `${visible ? '隐藏' : '显示'}本次输入的 API Key`)
  }
  keyRow.append(key, reveal); keyLabel.append(keyRow); form.append(keyLabel)
  const getKey = node('button', '去官方获取 Key', 'api-key-link'); getKey.type = 'button'
  getKey.onclick = () => { void api.openProviderConsole({ provider }).catch(() => { if (!disposed) notice.textContent = '官网未能打开，请重试。' }) }
  form.append(getKey)
  const endpoint = field('API 请求地址')
  endpoint.placeholder = '正在读取…'
  form.append(node('p', '请求地址由工具箱按当前 Agent 配对，无需修改。', 'platform-muted'))
  const modelLabel = node('label', '默认模型', 'provider-editor-field')
  const model = node('select'); model.name = 'model'; model.required = true; model.disabled = true
  model.setAttribute('aria-label', '默认模型')
  modelLabel.append(model); form.append(modelLabel)
  form.append(node('p', '选择此 Agent 使用的模型。能否使用取决于当前 Key 的权限，保存前会验证。', 'platform-muted'))
  const notice = node('p', '', 'platform-notice'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite')
  const footer = node('footer', '', 'provider-editor-footer')
  const retry = node('button', '重试读取', 'secondary-action'); retry.type = 'button'; retry.hidden = true
  retry.onclick = () => { void load() }
  const submit = node('button', '保存并验证', 'primary-action'); submit.type = 'submit'; submit.disabled = true
  const speed = node('button', '测速', 'secondary-action'); speed.type = 'button'; speed.disabled = true
  const speedResult = node('p', '', 'provider-latency-result'); speedResult.setAttribute('role', 'status'); speedResult.setAttribute('aria-live', 'polite')
  key.oninput = () => { speedResult.textContent = '' }
  model.onchange = () => { speedResult.textContent = ''; notice.textContent = '' }
  speed.onclick = () => { void testSpeed() }
  footer.append(retry, submit, speed)
  form.append(node('p', '仅为当前 Agent 保存并接入。留空沿用已保存的 Key。验证发送两次小型请求；测速只测首段有效回复耗时，不保存、不切换，会发送一次小型请求。均按服务商规则计费。', 'platform-muted'), notice, speedResult, footer)
  dialog.append(header, form)
  let disposed = false, busy = false, loaded = false
  const dispose = (): void => { if (disposed) return; disposed = true; key.value = ''; key.type = 'password'; dialog.remove(); restoreFocus() }
  dialog.addEventListener('close', dispose)
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault() })
  const load = async (): Promise<void> => {
    submit.disabled = true; retry.hidden = true; notice.textContent = ''
    try {
      const config: unknown = JSON.parse((await api.providerConfiguration({ shell, provider })).snapshot)
      if (disposed) return
      if (!config || typeof config !== 'object' || !('keyUrl' in config) || typeof config.keyUrl !== 'string' || !('endpoint' in config) || typeof config.endpoint !== 'string' || !('model' in config) || typeof config.model !== 'string' || !('models' in config) || !Array.isArray(config.models) || !config.models.length || config.models.some(item => typeof item !== 'string') || !config.models.includes(config.model)) throw new Error('PROVIDER_CONFIGURATION_INVALID')
      website.value = config.keyUrl; endpoint.value = config.endpoint
      model.replaceChildren(...config.models.map(id => Object.assign(node('option', id), { value: id }))); model.value = config.model
      loaded = true; submit.disabled = false; speed.disabled = false; model.disabled = false
    } catch { if (!disposed) { notice.textContent = '配置信息暂时无法读取，请重试。'; retry.hidden = false } }
  }
  const testSpeed = async (): Promise<void> => {
    if (busy || !loaded || !key.reportValidity()) return
    busy = true; submit.disabled = true; speed.disabled = true; key.disabled = true; model.disabled = true; close.disabled = true; reveal.disabled = true
    speed.textContent = '测速中…'; speedResult.textContent = ''
    const result = await measureProviderLatency(api, shell, provider, key.value.trim(), model.value)
    busy = false
    if (!disposed) { speedResult.textContent = result; submit.disabled = false; speed.disabled = false; key.disabled = false; model.disabled = false; close.disabled = false; reveal.disabled = false; speed.textContent = '测速' }
  }
  form.onsubmit = async event => {
    event.preventDefault()
    if (busy || !loaded) return
    busy = true; submit.disabled = true; speed.disabled = true; close.disabled = true; key.disabled = true; model.disabled = true; reveal.disabled = true; getKey.disabled = true
    submit.textContent = '正在验证…'; notice.textContent = '正在验证并接入当前 Agent，请稍候…'
    const value = key.value.trim(); key.value = ''; key.type = 'password'
    reveal.setAttribute('aria-pressed', 'false'); reveal.setAttribute('aria-label', '显示本次输入的 API Key')
    try {
      const result = await save(value || undefined, model.value)
      if (disposed) return
      if (result.ok) { dispose(); return }
      notice.textContent = result.message
      key.required = !result.keySaved; key.placeholder = result.keySaved ? '已保存，留空沿用原 Key' : '输入此渠道的 API Key'
    } catch { if (!disposed) notice.textContent = '保存或验证未完成，请检查后重试。' }
    finally {
      busy = false
      if (!disposed) { submit.disabled = false; speed.disabled = false; close.disabled = false; key.disabled = false; model.disabled = false; reveal.disabled = false; getKey.disabled = false; submit.textContent = '保存并验证' }
    }
  }
  document.body.append(dialog); dialog.showModal(); key.focus(); void load()
  return dispose
}
