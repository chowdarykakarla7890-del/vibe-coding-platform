import { describe, expect, it } from 'vitest'
import { assertDeploymentEnvironment, checkDeploymentEnvironment, deploymentBindings } from '@/lib/deployment/environment'

const previewRef = 'abcdefghijklmnopqrst'
const bindings = { ...deploymentBindings, previewDatabaseRef: previewRef }
const fixture = (target: 'preview' | 'production' = 'production') => ({
  VERCEL: '1', VERCEL_ENV: target,
  VERCEL_PROJECT_ID: bindings.projectId, VERCEL_TEAM_ID: bindings.teamId,
  NEXT_PUBLIC_SUPABASE_URL: `https://${target === 'production' ? bindings.productionDatabaseRef : previewRef}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'p'.repeat(32)}`,
  SUPABASE_SECRET_KEY: `sb_secret_${'s'.repeat(32)}`,
  CRON_SECRET: 'independent-worker-credential-0123456789',
  AI_GATEWAY_API_KEY: `gateway-${'g'.repeat(32)}`,
  VERCEL_AUTH_TOKEN: `sandbox-${'v'.repeat(32)}`,
})
const codes = (patch: Record<string, string | undefined>, target = 'production') =>
  checkDeploymentEnvironment({ ...fixture(), ...patch }, target, '24.18.0', bindings).map((issue) => issue.code)

describe('deployment environment guard', () => {
  it('accepts separately bound production and preview configurations', () => {
    for (const target of ['production', 'preview'] as const) {
      expect(checkDeploymentEnvironment(fixture(target), target, '24.18.0', bindings)).toEqual([])
    }
  })
  it('preserves the reviewed Sandbox-only credential project, but rejects unrelated projects', () => {
    expect(codes({ VERCEL_PROJECT_ID: bindings.sandboxProjectId })).toEqual([])
    expect(codes({ VERCEL_PROJECT_ID: 'prj_unrelated' })).toContain('PROJECT_BINDING')
  })
  it('fails closed until an isolated preview branch is recorded', () => {
    expect(checkDeploymentEnvironment(fixture('preview'), 'preview', '24.18.0').map((issue) => issue.code)).toContain('PREVIEW_DATABASE_UNCONFIGURED')
  })
  it('rejects production data in preview even if the preview binding is copied too', () => {
    const env = { ...fixture(), VERCEL_ENV: 'preview' }
    expect(checkDeploymentEnvironment(env, 'preview', '24.18.0', bindings).map((issue) => issue.code)).toContain('PREVIEW_DATABASE_ISOLATION')
    expect(checkDeploymentEnvironment(env, 'preview', '24.18.0', { ...bindings, previewDatabaseRef: bindings.productionDatabaseRef }).map((issue) => issue.code)).toContain('PREVIEW_DATABASE_ISOLATION')
  })
  it.each(['http://localhost:54321', 'https://wrong.supabase.co', `https://${previewRef}.supabase.co/path`, `https://secret@${previewRef}.supabase.co`, `https://${previewRef}.supabase.co?token=private`, `https://${previewRef}.supabase.co:9000`])('rejects unsafe or invalid database origins', (url) => {
    expect(codes({ NEXT_PUBLIC_SUPABASE_URL: url })).toContain('DATABASE_URL')
  })
  it('rejects a valid but wrong database project', () => {
    expect(codes({ NEXT_PUBLIC_SUPABASE_URL: `https://${previewRef}.supabase.co` })).toContain('DATABASE_BINDING')
  })
  it.each(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY', 'CRON_SECRET', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID'])('fails when a required service setting is missing', (key) => {
    expect(codes({ [key]: undefined }).length).toBeGreaterThan(0)
  })
  it.each(['', 'short', 'x'.repeat(31), 'x'.repeat(300), `${'x'.repeat(40)}\n`])('rejects missing or unsafe worker secrets', (secret) => {
    expect(codes({ CRON_SECRET: secret })).toContain('WORKER_SECRET')
  })
  it('rejects reusing a provider credential for worker authorization', () => {
    expect(codes({ CRON_SECRET: fixture().AI_GATEWAY_API_KEY })).toContain('SECRET_REUSE')
  })
  it('detects server secrets in arbitrary public variables without echoing any values', () => {
    for (const value of [fixture().SUPABASE_SECRET_KEY, fixture().CRON_SECRET, 'vcp_do-not-log-this-credential', 'vck_do-not-log-this-credential']) {
      const env = { ...fixture(), NEXT_PUBLIC_CONFIG: `prefix:${value}:suffix` }
      const issues = checkDeploymentEnvironment(env, 'production', '24.18.0', bindings)
      expect(issues.map((issue) => issue.code)).toContain('PUBLIC_SECRET_EXPOSURE')
      expect(JSON.stringify(issues)).not.toContain(value)
    }
  })
  it('rejects a server key in the browser publishable-key slot', () => {
    expect(codes({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: fixture().SUPABASE_SECRET_KEY })).toEqual(expect.arrayContaining(['PUBLISHABLE_KEY', 'PUBLIC_SECRET_EXPOSURE']))
  })
  it('requires provider authentication or an OIDC-shaped token', () => {
    expect(codes({ AI_GATEWAY_API_KEY: undefined, VERCEL_AUTH_TOKEN: undefined })).toEqual(expect.arrayContaining(['GATEWAY_AUTH', 'SANDBOX_AUTH']))
    expect(codes({ AI_GATEWAY_API_KEY: undefined, VERCEL_AUTH_TOKEN: undefined, VERCEL_OIDC_TOKEN: 'header.payload.signature' })).toEqual([])
    expect(codes({ VERCEL_OIDC_TOKEN: 'header.payload.signature', VERCEL_AUTH_TOKEN: 'invalid\n' })).toContain('SANDBOX_TOKEN')
    expect(codes({ VERCEL_OIDC_TOKEN: 'header.payload.signature', AI_GATEWAY_API_KEY: 'invalid\n' })).toContain('GATEWAY_TOKEN')
  })
  it('rejects conflicting targets and unreviewed custom environments', () => {
    expect(codes({}, 'staging')).toContain('DEPLOYMENT_TARGET')
    expect(codes({ VERCEL_ENV: 'preview' })).toContain('TARGET_MISMATCH')
    expect(codes({ VERCEL_TARGET_ENV: 'staging' })).toContain('TARGET_MISMATCH')
  })
  it('requires Node 24 without preventing ordinary local builds', () => {
    expect(checkDeploymentEnvironment(fixture(), 'production', '22.0.0', bindings).map((issue) => issue.code)).toContain('NODE_VERSION')
    expect(() => assertDeploymentEnvironment({ NODE_ENV: 'production' }, '24.18.0')).not.toThrow()
    expect(() => assertDeploymentEnvironment({ VERCEL: '1' }, '24.18.0')).toThrow('Deployment environment checks failed')
    expect(() => assertDeploymentEnvironment({ VERCEL: '1', VERCEL_ENV: 'development', NODE_ENV: 'development' }, '24.18.0')).not.toThrow()
    expect(() => assertDeploymentEnvironment({ VERCEL: '1', VERCEL_ENV: 'development', NODE_ENV: 'production' }, '24.18.0')).toThrow('DEPLOYMENT_TARGET')
  })
})
