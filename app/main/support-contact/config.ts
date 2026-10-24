import { readFileSync } from 'node:fs'

export interface SupportContactConfig {
  readonly customerServiceUrl: string
}

export function readSupportContactConfig(path: string): SupportContactConfig {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (
    typeof value !== 'object' ||
    value === null ||
    !('customerServiceUrl' in value) ||
    typeof value.customerServiceUrl !== 'string'
  ) {
    throw new Error('SUPPORT_CONTACT_CONFIG_INVALID')
  }
  const url = new URL(value.customerServiceUrl)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('SUPPORT_CONTACT_URL_INVALID')
  }
  return { customerServiceUrl: url.toString() }
}
