import type { HelpState } from '../../../../main/support-contact/help-state'
import { mountHelpContact } from './index'
import type { HelpContactProps } from './index'

export const helpContactDemoState: HelpState = {
  software: 'hermes',
  platform: 'mac',
  cardId: 'hermes.mac.install.open-installer',
  stageCode: 'installer-open',
  reasonCodes: ['INSTALLER_NOT_OPENED'],
  channelStatus: '已连',
  systemVersion: 'macOS 14.5',
  toolboxVersion: '0.2.0-compare.1'
}

export function mountHelpContactDemo(element: HTMLElement, props: HelpContactProps, copyText: (value: string) => Promise<void>): () => void {
  return mountHelpContact(element, { ...props, state: helpContactDemoState }, { copyText })
}
