import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { toolchainIssues } from '@/scripts/check-toolchain.mjs'
import { assertDatabaseTypesMatch } from '@/scripts/check-database-types.mjs'
import { isolatedBuildEnvironment } from '@/scripts/ci-smoke.mjs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const node = readFileSync('.node-version', 'utf8').trim()
it('pins the currently verified toolchain and every direct package', () => {
  expect(toolchainIssues(pkg, node, node)).toEqual([])
  expect(toolchainIssues({ ...pkg, packageManager: 'pnpm@latest' }, node, node).length).toBeGreaterThan(0)
  expect(toolchainIssues(pkg, '22.0.0', node).length).toBeGreaterThan(0)
  expect(toolchainIssues({ ...pkg, dependencies: { ...pkg.dependencies, next: '^16.3.1' } }, node, node).length).toBeGreaterThan(0)
})
it('removes paid and hosted service credentials from the standalone smoke process', () => {
  const env = isolatedBuildEnvironment({ VERCEL_AUTH_TOKEN: 'secret', VERCEL_OIDC_TOKEN: 'secret', SUPABASE_SECRET_KEY: 'secret', AI_GATEWAY_API_KEY: 'secret', VERCEL: '1' })
  expect(env).toMatchObject({ VERCEL: '0', VERCEL_AUTH_TOKEN: '', VERCEL_OIDC_TOKEN: '', AI_GATEWAY_API_KEY: '', SUPABASE_SECRET_KEY: '', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' })
})
it('compares public database contracts without hiding schema drift behind generator metadata', () => {
  const source = 'export type Database = { __InternalSupabase: { PostgrestVersion: "14" }; public: { Tables: { example: { Row: {id: string} } } } }'
  expect(() => assertDatabaseTypesMatch(source, source.replace('"14"', '"15"').replace('id: string', '/* generated */ id : string'))).not.toThrow()
  expect(() => assertDatabaseTypesMatch(source, source.replace('id: string', 'id: number'))).toThrow('drift')
  expect(() => assertDatabaseTypesMatch(source, 'export type Database = {}')).toThrow('Missing public')
  expect(() => assertDatabaseTypesMatch(source, 'not TypeScript {{{')).toThrow()
})
it('keeps the workflow non-deploying, read-only and pinned to immutable actions', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
  const actions = [...workflow.matchAll(/uses: ([^\s]+)/g)].map(match => match[1])
  expect(actions.length).toBe(4)
  for (const action of actions) expect(action).toMatch(/^actions\/(checkout|setup-node)@[a-f0-9]{40}$/)
  expect(workflow).toContain('contents: read')
  expect(workflow).not.toMatch(/pull_request_target|secrets\.|id-token: write|vercel (deploy|promote)|--linked|--project-ref/)
  expect(workflow).toContain('db reset --local --no-seed --yes')
  expect(workflow).toContain('needs: [application, database]')
  expect(workflow).toContain('if: always()')
})
it('refuses to run the destructive replay harness outside disposable CI', () => {
  const result = spawnSync(process.execPath, ['scripts/ci-database.mjs'], { encoding: 'utf8', timeout: 5000,
    env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'false' } })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('restricted to disposable GitHub CI')
})
