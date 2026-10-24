import { prepareSidecar } from './scripts/prepare-sidecar.mjs'
import { prepareMacWriteLock } from './scripts/prepare-mac-write-lock.mjs'

export default function setup() {
  prepareSidecar()
  prepareMacWriteLock()
}
