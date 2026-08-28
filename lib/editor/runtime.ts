import { dependencies } from '../../package.json'

// Both the build-time asset copier and browser resolve the exact direct pin.
export const MONACO_VERSION = dependencies['monaco-editor']
export const MONACO_ASSET_PATH = `/vendor/monaco/${MONACO_VERSION}/vs`
export const MONACO_LOAD_TIMEOUT_MS = 20_000
