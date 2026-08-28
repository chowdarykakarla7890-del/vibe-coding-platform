import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APIError, Sandbox } from '@vercel/sandbox'
import { createOwnedSandbox, getOwnedSandbox, stopSandboxByName } from '@/lib/server/sandbox'
import { requireOwnedProject, requireOwnedSandbox, type AuthContext } from '@/lib/server/api'
import { prepareDSARuntime } from '@/lib/sandbox/dsa-runtime'
import { prepareLearningCompiler } from '@/lib/sandbox/learning-compiler'
import { scheduleSandboxCleanup } from '@/lib/server/sandbox-cleanup-dispatch'
import { TRUSTED_DSA_IDS } from '@/lib/learning/dsa'
import { DSA_LANGUAGES } from '@/lib/learning/dsa-foundations'
import { PRACTICE_ACTIVITIES } from '@/lib/learning/practice'
import { DEBUG_ACTIVITIES } from '@/lib/learning/debug'
import { PROJECT_ACTIVITIES } from '@/lib/learning/blueprints'
import { TRUSTED_CHALLENGE_IDS, challengeLanguage } from '@/lib/learning/challenges/contracts'

const db = vi.hoisted(() => {
  const query = {
    eq: vi.fn(), in: vi.fn(), select: vi.fn(), update: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data: { id: 'reservation-id' }, error: null })),
    then: (resolve: (value: unknown) => void) => Promise.resolve({ error: null }).then(resolve),
  }
  return { query, rpc: vi.fn(async () => ({ data: 'reservation-id', error: null })), from: vi.fn(() => query) }
})
vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/sandbox-cleanup-dispatch', () => ({ scheduleSandboxCleanup: vi.fn() }))
vi.mock('@/lib/sandbox/dsa-runtime', () => ({ prepareDSARuntime: vi.fn() }))
vi.mock('@/lib/sandbox/learning-compiler', () => ({ prepareLearningCompiler: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: () => db }))
vi.mock('@/lib/server/api', async (original) => ({ ...await original<typeof import('@/lib/server/api')>(), requireOwnedProject: vi.fn(), requireOwnedSandbox: vi.fn() }))
vi.mock('@/lib/server/rate-limit', () => ({ consumeQuota: vi.fn(async () => ({})) }))
vi.mock('@/ai/sandbox', async (original) => ({ ...await original<typeof import('@/ai/sandbox')>(), getSandboxCredentials: () => ({}) }))

const auth = { user: { id: 'owner' } } as AuthContext
beforeEach(() => {
  for (const fn of [db.query.eq, db.query.in, db.query.select, db.query.update]) fn.mockReturnValue(db.query)
  vi.mocked(requireOwnedProject).mockResolvedValue({ id: 'project' } as Awaited<ReturnType<typeof requireOwnedProject>>)
  vi.mocked(requireOwnedSandbox).mockResolvedValue({ id: 'record', project_id: 'project' } as Awaited<ReturnType<typeof requireOwnedSandbox>>)
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

describe('Sandbox 3 session lifecycle', () => {
  it.each(TRUSTED_CHALLENGE_IDS)('prepares a trusted runtime for %s before learner access', async activity_id => {
    const language=challengeLanguage(activity_id),vm={status:'running'}
    vi.mocked(requireOwnedProject).mockResolvedValue({id:'project',activity_id,language} as never)
    vi.spyOn(Sandbox,'create').mockResolvedValue({name:'owned',status:'running',currentSession:()=>vm} as never)
    vi.mocked(prepareDSARuntime).mockImplementation(async()=>{expect(db.query.update).not.toHaveBeenCalled()})
    await createOwnedSandbox(auth,'project',{})
    expect(prepareDSARuntime).toHaveBeenCalledWith(vm,language,undefined)
    expect(prepareLearningCompiler).not.toHaveBeenCalled()
  })
  it.each([...PRACTICE_ACTIVITIES, ...DEBUG_ACTIVITIES, ...PROJECT_ACTIVITIES].filter(activity => ['Java', 'C++'].includes(activity.language)))('prepares curated $id before attaching its sandbox', async activity => {
    const language = activity.language
    vi.mocked(requireOwnedProject).mockResolvedValue({ id: 'project', activity_id: activity.id, language } as never)
    const vm = { status: 'running' }
    vi.spyOn(Sandbox, 'create').mockResolvedValue({ name: 'owned', status: 'running', currentSession: () => vm } as never)
    vi.mocked(prepareLearningCompiler).mockImplementation(async () => { expect(db.query.update).not.toHaveBeenCalled() })
    await createOwnedSandbox(auth, 'project', {})
    expect(prepareLearningCompiler).toHaveBeenCalledWith(vm, language, undefined)
    expect(prepareDSARuntime).not.toHaveBeenCalled()
  })
  it.each(['practice-java-composition', 'debug-java-state-bug', 'project-java-blueprint'])('cleans up failed %s compiler setup without exposing an incomplete VM', async activity_id => {
    vi.mocked(requireOwnedProject).mockResolvedValue({ id: 'project', activity_id, language: 'Java' } as never)
    const stop = vi.fn(async () => {})
    vi.spyOn(Sandbox, 'create').mockResolvedValue({ name: 'owned', status: 'running', currentSession: () => ({}), stop } as never)
    vi.mocked(prepareLearningCompiler).mockRejectedValueOnce(new Error('Compiler unavailable'))
    await expect(createOwnedSandbox(auth, 'project', {})).rejects.toThrow('Compiler unavailable')
    expect(stop).toHaveBeenCalledOnce()
    expect(db.query.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
  })
  it.each([
    ['debug-java-state-bug', 'C++'],
    ['debug-java-untrusted', 'Java'],
    ['generated-debug-java-state-bug', 'Java'],
    ['challenge-java-transform', 'C++'],
    ['generated-challenge-java-transform', 'Java'],
    ['project-java-blueprint', 'C++'],
    ['project-java-unknown', 'Java'],
    ['generated-project-java-blueprint', 'Java'],
  ])('never installs a curated compiler for an unmatched %s/%s', async (activity_id, language) => {
    vi.mocked(requireOwnedProject).mockResolvedValue({ id: 'project', activity_id, language } as never)
    vi.spyOn(Sandbox, 'create').mockResolvedValue({ name: 'owned', status: 'running', currentSession: () => ({}) } as never)
    await createOwnedSandbox(auth, 'project', {})
    expect(prepareLearningCompiler).not.toHaveBeenCalled()
    expect(prepareDSARuntime).not.toHaveBeenCalled()
  })
  it('does not reserve resources for an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort()
    const create = vi.spyOn(Sandbox, 'create')
    await expect(createOwnedSandbox(auth, 'project', {}, controller.signal)).rejects.toMatchObject({ status: 408, code: 'SANDBOX_START_CANCELLED' })
    expect(requireOwnedProject).not.toHaveBeenCalled()
    expect(db.rpc).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
  it('releases a reservation cancelled before VM creation without inventing a VM to stop', async () => {
    const controller = new AbortController()
    db.rpc.mockImplementationOnce(async () => { controller.abort(); return { data: 'reservation-id', error: null } })
    const create = vi.spyOn(Sandbox, 'create'), get = vi.spyOn(Sandbox, 'get')
    await expect(createOwnedSandbox(auth, 'project', {}, controller.signal)).rejects.toMatchObject({ status: 408 })
    expect(create).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled()
    expect(db.query.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(db.query.update).toHaveBeenCalledWith(expect.objectContaining({ state: 'complete', outcome: 'not_started' }))
  })
  it('stops a VM whose creation acknowledgment arrives after cancellation and never attaches it', async () => {
    const controller = new AbortController(), stop = vi.fn(async () => {})
    const create = vi.spyOn(Sandbox, 'create').mockImplementation(async () => {
      controller.abort()
      return { name: 'owned', status: 'running', stop } as never
    })
    await expect(createOwnedSandbox(auth, 'project', {}, controller.signal)).rejects.toMatchObject({ status: 408 })
    expect(create.mock.calls[0][0]?.signal?.aborted).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    expect(db.query.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
  })
  it('cleans up if cancellation races the durable session attachment', async () => {
    const controller = new AbortController(), stop = vi.fn(async () => {})
    vi.spyOn(Sandbox, 'create').mockResolvedValue({ name: 'owned', status: 'running', stop } as never)
    db.query.maybeSingle.mockImplementationOnce(async () => { controller.abort(); return { data: { id: 'reservation-id' }, error: null } })
    await expect(createOwnedSandbox(auth, 'project', {}, controller.signal)).rejects.toMatchObject({ status: 408 })
    expect(stop).toHaveBeenCalledOnce()
    expect(db.query.update).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }))
  })
  it.each(TRUSTED_DSA_IDS.flatMap(id => DSA_LANGUAGES.map(language => [id, language] as const)))('prepares %s/%s only on a fresh VM before attaching it', async (activity_id, language) => {
    vi.mocked(requireOwnedProject).mockResolvedValue({ id: 'project', activity_id, language } as never)
    const vm = { status: 'running' }
    vi.spyOn(Sandbox, 'create').mockResolvedValue({ name: 'owned', status: 'running', currentSession: () => vm } as never)
    vi.mocked(prepareDSARuntime).mockImplementation(async () => { expect(db.query.update).not.toHaveBeenCalled() })
    await createOwnedSandbox(auth, 'project', {})
    expect(prepareDSARuntime).toHaveBeenCalledWith(vm, language, undefined)
  })
  it('stops a fresh VM and leaves no running association if compiler preparation fails', async () => {
    vi.mocked(requireOwnedProject).mockResolvedValue({ id: 'project', activity_id: 'dsa-python-two-sum', language: 'Java' } as never)
    const stop = vi.fn(async () => {})
    vi.spyOn(Sandbox, 'create').mockResolvedValue({ name: 'owned', status: 'running', currentSession: () => ({}), stop } as never)
    vi.mocked(prepareDSARuntime).mockRejectedValueOnce(new Error('Unavailable'))
    await expect(createOwnedSandbox(auth, 'project', {})).rejects.toThrow('Unavailable')
    expect(stop).toHaveBeenCalledOnce()
    expect(db.query.update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
  })
  it('keeps the public sandboxId field while registering an ephemeral named sandbox', async () => {
    const create = vi.spyOn(Sandbox, 'create').mockResolvedValue({ name: 'codetutor-reservation-id', status: 'running', expiresAt: new Date('2099-01-01') } as Awaited<ReturnType<typeof Sandbox.create>>)
    await expect(createOwnedSandbox(auth, 'project', { ports: [3000, 3000] })).resolves.toEqual({ sandboxId: 'codetutor-reservation-id', status: 'running' })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'codetutor-reservation-id', persistent: false, ports: [3000], signal: expect.any(AbortSignal) }))
    expect(db.query.update).toHaveBeenCalledWith(expect.objectContaining({ sandbox_id: 'codetutor-reservation-id', expires_at: '2099-01-01T00:00:00.000Z' }))
  })

  it('returns the fixed VM session, never an auto-resuming Sandbox wrapper', async () => {
    const session = { status: 'running', sessionId: 'session-id' }
    const get = vi.spyOn(Sandbox, 'get').mockResolvedValue({ currentSession: () => session } as unknown as Sandbox)
    expect(await getOwnedSandbox(auth, 'codetutor-name', 'project')).toBe(session)
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ name: 'codetutor-name', resume: false }))
  })

  it('checks the owned project before any SDK lookup', async () => {
    const get = vi.spyOn(Sandbox, 'get')
    await expect(getOwnedSandbox(auth, 'codetutor-name', 'other-project')).rejects.toMatchObject({ status: 404 })
    expect(get).not.toHaveBeenCalled()
  })

  it.each(['stopped', 'missing', 'legacy'] as const)('maps a %s session to recoverable expiration', async (state) => {
    const get = vi.spyOn(Sandbox, 'get')
    if (state === 'legacy') get.mockRejectedValue(new APIError(new Response('', { status: 404 }), { json: { error: { code: 'not_found' } } }))
    else get.mockResolvedValue({ currentSession: () => {
      if (state === 'missing') throw new Error('No active session')
      return { status: 'stopped' }
    } } as unknown as Sandbox)
    await expect(getOwnedSandbox(auth, 'owned-sandbox', 'project')).rejects.toMatchObject({ status: 410, code: 'SANDBOX_EXPIRED' })
    expect(db.query.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }))
  })

  it('stops a known-name orphan if creation succeeded but its response was lost', async () => {
    vi.spyOn(Sandbox, 'create').mockRejectedValue(new DOMException('Timeout', 'TimeoutError'))
    const stop = vi.fn(async () => {})
    const get = vi.spyOn(Sandbox, 'get').mockResolvedValue({ currentSession: () => ({ status: 'running', stop }) } as unknown as Sandbox)
    await expect(createOwnedSandbox(auth, 'project', {})).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ name: 'codetutor-reservation-id', resume: false }))
    expect(stop).toHaveBeenCalledOnce()
    expect(db.query.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
  })

  it('retains and dispatches cleanup after both creation and its first shutdown fail', async () => {
    vi.spyOn(Sandbox, 'create').mockRejectedValue(new DOMException('Timeout', 'TimeoutError'))
    vi.spyOn(Sandbox, 'get').mockRejectedValue(new Error('Provider unavailable'))
    await expect(createOwnedSandbox(auth, 'project', {})).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(db.query.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(db.query.update).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'complete' }))
    expect(scheduleSandboxCleanup).toHaveBeenCalledWith(['reservation-id'])
  })

  it('does not wake a stopped sandbox just to delete a project', async () => {
    const stop = vi.fn()
    const get = vi.spyOn(Sandbox, 'get').mockResolvedValue({ currentSession: () => ({ status: 'stopped', stop }) } as unknown as Sandbox)
    await stopSandboxByName('owned-sandbox')
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ resume: false }))
    expect(stop).not.toHaveBeenCalled()
  })
})
