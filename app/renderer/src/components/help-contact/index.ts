import type { SupportContactConfig } from '../../../../main/support-contact/config'
import { formatHelpState } from '../../../../main/support-contact/help-state'
import type { HelpState } from '../../../../main/support-contact/help-state'
import { createLocalQrCode } from './qr'

export interface HelpContactProps {
  readonly configuration: SupportContactConfig
  readonly state: HelpState
}

export interface HelpContactMountOptions {
  readonly copyText?: (value: string) => Promise<void>
  readonly openContact?: () => Promise<unknown>
}

export interface HelpContactViewModel {
  readonly customerServiceUrl: string
  readonly currentStateText: string
  readonly qrCode: ReturnType<typeof createLocalQrCode>
}

export function buildHelpContactViewModel(props: HelpContactProps): HelpContactViewModel {
  return {
    customerServiceUrl: props.configuration.customerServiceUrl,
    currentStateText: formatHelpState(props.state),
    qrCode: createLocalQrCode(props.configuration.customerServiceUrl)
  }
}

export function mountHelpContact(element: HTMLElement, props: HelpContactProps, options: HelpContactMountOptions = {}): () => void {
  const view = buildHelpContactViewModel(props)
  const document = element.ownerDocument
  if (document === null) {
    throw new Error('SUPPORT_CONTACT_DOCUMENT_MISSING')
  }
  const heading = document.createElement('h3')
  heading.textContent = '联系人工客服'
  const link = document.createElement('a')
  link.href = view.customerServiceUrl
  link.textContent = '打开企业微信客服'
  link.rel = 'noreferrer'
  const qr = createQrSvg(document, view.qrCode.modules)
  qr.setAttribute('aria-label', '企业微信客服二维码')
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = '复制问题信息'
  const write = options.copyText ?? copyWithClipboard
  const message = document.createElement('p')
  message.setAttribute('role', 'status')
  const onCopy = (): void => {
    void write(view.currentStateText).then(() => { message.textContent = '已复制，可发送给客服。' }, () => { message.textContent = view.currentStateText })
  }
  const onOpen = (event: Event): void => {
    if (!options.openContact) return
    event.preventDefault()
    void options.openContact().catch(() => { message.textContent = '未能打开企业微信，请用手机微信扫描二维码。' })
  }
  link.addEventListener('click', onOpen)
  copy.addEventListener('click', onCopy)
  element.replaceChildren(heading, link, qr, copy, message)
  return () => { copy.removeEventListener('click', onCopy); link.removeEventListener('click', onOpen) }
}

function createQrSvg(document: Document, modules: readonly (readonly boolean[])[]): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const size = modules.length
  // Four light modules around the QR are required for reliable scanning.
  svg.setAttribute('viewBox', `-4 -4 ${size + 8} ${size + 8}`)
  svg.setAttribute('role', 'img')
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  background.setAttribute('x', '-4')
  background.setAttribute('y', '-4')
  background.setAttribute('width', String(size + 8))
  background.setAttribute('height', String(size + 8))
  background.setAttribute('fill', 'white')
  const dots = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  dots.setAttribute('fill', 'black')
  dots.setAttribute(
    'd',
    modules
      .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1H${x}z` : '')))
      .filter((path) => path !== '')
      .join('')
  )
  svg.append(background, dots)
  return svg
}

async function copyWithClipboard(value: string): Promise<void> {
  if (navigator.clipboard === undefined) {
    throw new Error('SUPPORT_CONTACT_CLIPBOARD_UNAVAILABLE')
  }
  await navigator.clipboard.writeText(value)
}
