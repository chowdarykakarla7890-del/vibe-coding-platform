import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/** Resolve via the public entry: Monaco's exports map does not expose package.json.
 * @param {string} root */
export function installedMonaco(root = process.cwd()) {
  const manifestPath = join(resolve(root), 'package.json')
  const pin = JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies?.['monaco-editor']
  if (typeof pin !== 'string' || !/^\d+\.\d+\.\d+$/.test(pin)) throw new Error('Monaco requires an exact stable version pin.')
  let source = dirname(createRequire(manifestPath).resolve('monaco-editor'))
  while (!existsSync(join(source, 'package.json'))) {
    const parent = dirname(source)
    if (parent === source) throw new Error('The Monaco package manifest is missing.')
    source = parent
  }
  const packagePath = join(source, 'package.json')
  if (JSON.parse(readFileSync(packagePath, 'utf8')).name !== 'monaco-editor') throw new Error('The resolved editor package is not Monaco.')
  const installed = JSON.parse(readFileSync(packagePath, 'utf8')).version
  if (installed !== pin) throw new Error('Installed Monaco does not match the application pin. Run the frozen install.')
  return { source, pin }
}

/** Copy only the pinned package's browser distribution, never application data.
 * Called by Next's dev/build config, including direct `next build` invocations.
 * @param {string} root
 */
export function prepareMonaco(root = process.cwd()) {
  const { source, pin } = installedMonaco(root)
  // Fail the build on missing assets instead of deploying an infinite loader.
  for (const path of ['min/vs/loader.js', 'min/vs/editor/editor.main.js', 'min/vs/editor/editor.worker.js', 'LICENSE', 'ThirdPartyNotices.txt']) {
    if (!statSync(join(source, path)).isFile()) throw new Error('The Monaco runtime distribution is incomplete.')
  }
  const target = join(root, 'public', 'vendor', 'monaco', pin)
  mkdirSync(target, { recursive: true })
  cpSync(join(source, 'min', 'vs'), join(target, 'vs'), { recursive: true })
  for (const path of ['LICENSE', 'ThirdPartyNotices.txt']) copyFileSync(join(source, path), join(target, path))
  return { version: pin, path: `/vendor/monaco/${pin}/vs` }
}
