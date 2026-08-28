import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { DELETE } from '@/app/api/projects/[projectId]/route'
import { requireUser, requireOwnedProject, ApiError } from '@/lib/server/api'
import { scheduleSandboxCleanup } from '@/lib/server/sandbox-cleanup-dispatch'
const db=vi.hoisted(()=>{
  let removing=false
  const state={error:null as unknown,sessions:[{id:'11111111-1111-4111-8111-111111111111'}]}
  const query={select:vi.fn(()=>{removing=false;return query}),delete:vi.fn(()=>{removing=true;return query}),eq:vi.fn(()=>query),
    then:(resolve:(value:unknown)=>void)=>Promise.resolve(removing?{error:state.error}:{data:state.sessions,error:null}).then(resolve)}
  return {state,query,from:vi.fn(()=>query)}
})
vi.mock('server-only',()=>({}))
vi.mock('@/lib/supabase/server',()=>({createAdminSupabaseClient:()=>db}))
vi.mock('@/lib/server/sandbox-cleanup-dispatch',()=>({scheduleSandboxCleanup:vi.fn()}))
vi.mock('@/lib/server/api',async original=>({...await original<typeof import('@/lib/server/api')>(),requireUser:vi.fn(),requireOwnedProject:vi.fn()}))
const auth={user:{id:'owner'}}
const context={params:Promise.resolve({projectId:'22222222-2222-4222-8222-222222222222'})}
const request=(origin='http://localhost')=>new Request('http://localhost/api/projects/id',{method:'DELETE',headers:{origin}})
beforeEach(()=>{vi.clearAllMocks();db.state.error=null;vi.mocked(requireUser).mockResolvedValue(auth as never);vi.mocked(requireOwnedProject).mockResolvedValue({id:'project'} as never);vi.spyOn(console,'error').mockImplementation(()=>{})})
afterEach(()=>vi.restoreAllMocks())
it('dispatches deterministic reservation IDs only after deletion and its trigger commit',async()=>{
  const response=await DELETE(request(),context)
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({deleted:true,sandboxCleanup:'scheduled'})
  expect(db.query.eq).toHaveBeenCalledWith('user_id','owner')
  expect(db.query.select).toHaveBeenCalledWith('id')
  expect(scheduleSandboxCleanup).toHaveBeenCalledWith([db.state.sessions[0].id])
  expect(db.query.delete.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(scheduleSandboxCleanup).mock.invocationCallOrder[0])
})
it('does not dispatch or claim deletion succeeded when the database transaction fails',async()=>{
  db.state.error=new Error('internal')
  expect((await DELETE(request(),context)).status).toBe(502)
  expect(scheduleSandboxCleanup).not.toHaveBeenCalled()
})
it('rejects anonymous, cross-user and cross-origin deletion before mutations',async()=>{
  vi.mocked(requireUser).mockRejectedValueOnce(new ApiError(401,'AUTH_REQUIRED','Sign in.'))
  expect((await DELETE(request(),context)).status).toBe(401)
  vi.mocked(requireOwnedProject).mockRejectedValueOnce(new ApiError(404,'PROJECT_NOT_FOUND','Not found.'))
  expect((await DELETE(request(),context)).status).toBe(404)
  expect((await DELETE(request('https://other.invalid'),context)).status).toBe(403)
  expect(db.query.delete).not.toHaveBeenCalled();expect(scheduleSandboxCleanup).not.toHaveBeenCalled()
})
