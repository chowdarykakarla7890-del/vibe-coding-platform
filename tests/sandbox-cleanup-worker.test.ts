import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { APIError, Sandbox } from '@vercel/sandbox'
import { processSandboxCleanup, runSandboxCleanupBatch } from '@/lib/server/sandbox-cleanup-worker'
import { GET } from '@/app/api/internal/sandbox-cleanup/route'
import { createAdminSupabaseClient } from '@/lib/supabase/server'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createAdminSupabaseClient: vi.fn() }))
vi.mock('@/ai/sandbox', async original => ({ ...await original<typeof import('@/ai/sandbox')>(), getSandboxCredentials: () => ({}) }))
const id='11111111-1111-4111-8111-111111111111', token='22222222-2222-4222-8222-222222222222'
let row: unknown, settlement: unknown, settledError: unknown
const rpc = vi.fn()
const stop = vi.fn()
beforeEach(() => {
  vi.clearAllMocks(); row={id,lease_token:token,sandbox_name:`codetutor-${id}`}; settlement=true; settledError=null
  vi.mocked(createAdminSupabaseClient).mockReturnValue({ rpc } as never)
  rpc.mockImplementation((name:string) => ({ abortSignal: () => Promise.resolve(name==='claim_sandbox_cleanup'
    ? { data:row,error:null } : { data:settlement,error:settledError }) }))
  vi.spyOn(Sandbox,'get').mockResolvedValue({status:'running',stop} as never)
  stop.mockResolvedValue({status:'stopped'})
  vi.spyOn(console,'info').mockImplementation(()=>{})
  vi.spyOn(console,'warn').mockImplementation(()=>{})
})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers()})
it('stops only the claimed database handle without ever resuming it',async()=>{
  expect(await processSandboxCleanup(id)).toBe('stopped')
  expect(Sandbox.get).toHaveBeenCalledWith(expect.objectContaining({name:`codetutor-${id}`,resume:false,signal:expect.any(AbortSignal)}))
  expect(rpc).toHaveBeenLastCalledWith('settle_sandbox_cleanup',{p_job_id:id,p_lease_token:token,p_outcome:'stopped'})
})
it('never calls Stop again for an already stopped VM',async()=>{
  vi.mocked(Sandbox.get).mockResolvedValue({status:'stopped',stop} as never)
  expect(await processSandboxCleanup(id)).toBe('stopped');expect(stop).not.toHaveBeenCalled()
})
it.each(['failed','aborted','no-session'])('keeps %s in the observation window rather than retrying an impossible Stop',async status=>{
  vi.mocked(Sandbox.get).mockResolvedValue({get status(){if(status==='no-session')throw new Error('No current session');return status},stop} as never)
  expect(await processSandboxCleanup(id)).toBe('unavailable');expect(stop).not.toHaveBeenCalled()
})
it('settles a stalled provider request on its deadline and ignores its late response',async()=>{
  const deadline=new AbortController()
  vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>ms===25000?deadline.signal:new AbortController().signal)
  let finish!:(value:Sandbox)=>void
  vi.mocked(Sandbox.get).mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const task=processSandboxCleanup(id)
  await vi.waitFor(()=>expect(Sandbox.get).toHaveBeenCalledOnce())
  deadline.abort()
  expect(await task).toBe('retry')
  finish({status:'running',stop} as never)
  await Promise.resolve();expect(stop).not.toHaveBeenCalled()
})
it('bounds a stalled settlement without claiming success or retrying it twice',async()=>{
  const deadline=new AbortController()
  vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>ms===5000?deadline.signal:new AbortController().signal)
  rpc.mockImplementation((name:string)=>({abortSignal:()=>name==='claim_sandbox_cleanup'?Promise.resolve({data:row,error:null}):new Promise(()=>{})}))
  const task=processSandboxCleanup(id)
  const failure=expect(task).rejects.toMatchObject({name:'AbortError'})
  await vi.waitFor(()=>expect(rpc).toHaveBeenCalledTimes(2));deadline.abort();await failure
  expect(rpc).toHaveBeenCalledTimes(2)
})
it('retains provider failures as retryable work without logging raw errors',async()=>{
  stop.mockRejectedValue(new Error('token=private file content'))
  expect(await processSandboxCleanup(id)).toBe('retry')
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('private')
})
it('records missing resources separately; the database owns the observation window',async()=>{
  vi.mocked(Sandbox.get).mockRejectedValue(new APIError(new Response('',{status:404}),{json:{error:{code:'not_found'}}}))
  expect(await processSandboxCleanup(id)).toBe('unavailable')
  expect(stop).not.toHaveBeenCalled()
})
it('does not claim a stopped VM when its stop response is incomplete',async()=>{
  stop.mockResolvedValue({status:'stopping'})
  expect(await processSandboxCleanup(id)).toBe('retry')
})
it('releases an identifiable malformed job without calling the provider',async()=>{
  row={id,lease_token:token,sandbox_name:'https://attacker.invalid'}
  expect(await processSandboxCleanup(id)).toBe('retry');expect(Sandbox.get).not.toHaveBeenCalled()
})
it('does nothing for an unclaimed or already leased job',async()=>{
  row=null;expect(await processSandboxCleanup(id)).toBe('idle');expect(Sandbox.get).not.toHaveBeenCalled();expect(rpc).toHaveBeenCalledOnce()
})
it('never performs paid work for invalid job IDs or failed claims',async()=>{
  await expect(processSandboxCleanup('not-a-uuid')).rejects.toThrow()
  rpc.mockReturnValue({abortSignal:()=>Promise.resolve({data:null,error:{message:'internal'}})})
  await expect(processSandboxCleanup(id)).rejects.toThrow('claim unavailable')
  expect(Sandbox.get).not.toHaveBeenCalled()
})
it('does not settle a lost lease twice or replace the original result',async()=>{
  settlement=false
  await expect(processSandboxCleanup(id)).rejects.toThrow('settlement unconfirmed')
  expect(rpc.mock.calls.filter(([name])=>name==='settle_sandbox_cleanup')).toHaveLength(1)
})
it('settles cancellation independently of the cancelled request signal',async()=>{
  const controller=new AbortController()
  vi.mocked(Sandbox.get).mockImplementation(async()=>{controller.abort();return {status:'running',stop} as never})
  expect(await processSandboxCleanup(id,controller.signal)).toBe('retry')
  expect(stop).not.toHaveBeenCalled()
  expect(rpc).toHaveBeenLastCalledWith('settle_sandbox_cleanup',expect.objectContaining({p_outcome:'retry'}))
})
it('bounds the batch and deduplicates explicitly dispatched IDs',async()=>{
  expect(await runSandboxCleanupBatch([id,id])).toEqual({processed:1,failed:0,unconfirmed:0})
  expect(stop).toHaveBeenCalledOnce()
  vi.clearAllMocks()
  expect((await runSandboxCleanupBatch()).processed).toBe(10)
  expect(stop).toHaveBeenCalledTimes(10)
})
it('enforces worker authorization before any claim',async()=>{
  vi.stubEnv('CRON_SECRET','')
  expect((await GET(new Request('http://localhost/api/internal/sandbox-cleanup'))).status).toBe(503)
  vi.stubEnv('CRON_SECRET','a'.repeat(40))
  expect((await GET(new Request('http://localhost/api/internal/sandbox-cleanup'))).status).toBe(401)
  expect(rpc).not.toHaveBeenCalled()
  row=null
  const response=await GET(new Request('http://localhost/api/internal/sandbox-cleanup',{headers:{authorization:`Bearer ${'a'.repeat(40)}`}}))
  expect(response.status).toBe(200);expect(response.headers.get('x-request-id')).toBeTruthy()
})
