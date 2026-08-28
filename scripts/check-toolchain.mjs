import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function toolchainIssues(manifest, nodeVersion, pinnedNode) {
  const issues = []
  if (manifest.engines?.node !== '24.x' || !/^24\.\d+\.\d+$/.test(pinnedNode)) issues.push('Pin a Node 24 release in .node-version and keep engines.node at 24.x.')
  if (nodeVersion !== pinnedNode) issues.push('Use the exact Node release from .node-version for the release check.')
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager ?? '')) issues.push('Pin an exact pnpm packageManager version.')
  for (const group of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(manifest[group] ?? {})) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) issues.push(`Pin a stable exact version for ${name}.`)
    }
  }
  if (manifest.dependencies?.next !== manifest.devDependencies?.['eslint-config-next']) issues.push('Keep Next.js and eslint-config-next versions matched.')
  if (manifest.dependencies?.react !== manifest.dependencies?.['react-dom']) issues.push('Keep React and React DOM versions matched.')
  return issues
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const pinnedNode = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim()
  const issues = toolchainIssues(manifest, process.versions.node, pinnedNode)
  if (issues.length) { issues.forEach(issue => console.error(issue)); process.exitCode = 1 }
  else console.log('Exact release toolchain and direct dependency pins verified.')
}
