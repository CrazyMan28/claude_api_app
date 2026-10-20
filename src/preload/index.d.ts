import type { ForgeApi } from '../shared/types'

declare global {
  interface Window {
    forge: ForgeApi
  }
}

export {}
