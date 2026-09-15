function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.textContent = text; return node
}

/** 交付账号资料逐字段展示:只读 textarea + 一键复制,点击后短暂显示「已复制」。 */
export function renderSecretFields(area: HTMLElement, fields: readonly { name: string; value: string; rows: number }[]): void {
  for (const field of fields) {
    const label = el('label', field.name)
    const copy = el('button', '复制'); copy.type = 'button'; copy.className = 'sub-copy'
    const reset = (): void => { copy.textContent = '复制'; copy.disabled = false }
    copy.addEventListener('click', () => {
      copy.disabled = true
      void Promise.resolve().then(() => {
        if (navigator.clipboard === undefined) throw new Error('SECRET_CLIPBOARD_UNAVAILABLE')
        return navigator.clipboard.writeText(field.value)
      }).then(() => {
        copy.textContent = '已复制'
        setTimeout(reset, 1500)
      }, () => {
        copy.textContent = '复制失败'
        setTimeout(reset, 1500)
      })
    })
    label.append(copy)
    const input = el('textarea'); input.readOnly = true; input.value = field.value; input.rows = field.rows
    label.append(input)
    area.append(label)
  }
}
