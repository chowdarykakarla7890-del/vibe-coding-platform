import { copyFileSync, cpSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/** Copy only the pinned package's browser distribution, never application data.
 * Called by Next's dev/build config, including direct `next build` invocations.
 * @param {string} root
 */
export function prepareMonaco(root = process.cwd()) {
  const manifestPath = join(resolve(root), 'package.json')
  const pin = JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies?.['monaco-editor']
  if (typeof pin !== 'string' || !/^\d+\.\d+\.\d+$/.test(pin)) throw new Error('Monaco requires an exact stable version pin.')
  const packagePath = createRequire(manifestPath).resolve('monaco-editor/package.json')
  const installed = JSON.parse(readFileSync(packagePath, 'utf8')).version
  if (installed !== pin) throw new Error('Installed Monaco does not match the application pin. Run the frozen install.')
  const source = dirname(packagePath)
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
