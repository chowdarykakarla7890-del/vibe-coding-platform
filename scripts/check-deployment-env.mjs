import { checkDeploymentEnvironment } from '../lib/deployment/environment.ts'

const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--target' || !['preview', 'production'].includes(args[1])) {
  console.error('Usage: node [--env-file=<private-file>] scripts/check-deployment-env.mjs --target preview|production')
  process.exitCode = 1
} else {
  const issues = checkDeploymentEnvironment(process.env, args[1], process.versions.node)
  for (const issue of issues) console.error(`${issue.code}: ${issue.message}`)
  if (issues.length) process.exitCode = 1
  else console.log('Offline deployment configuration checks passed. Live credentials, migrations, OAuth, and release gates still need verification.')
}
