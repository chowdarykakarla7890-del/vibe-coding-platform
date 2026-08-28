import { expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { Sandbox } from '@vercel/sandbox'
import { getSandboxCredentials, isSandboxUnavailableError } from '@/ai/sandbox'
import { processSourceCapture } from '@/lib/server/source-capture-worker'
import { dsaSolutions } from './fixtures/dsa-solutions'
import { challengeSolution } from './fixtures/challenge-solutions'
import type { Database } from '@/lib/supabase/database.types'
import { gradingSummarySchema } from '@/lib/learning/grading-evidence'
import { archivePageSchema, archiveReceiptSchema, archiveRecordSchema, verifyArchivePage } from '@/lib/projects/archive'

vi.mock('server-only', () => ({}))
// Rebuilt LOCAL HTTP app, hosted DB, two temporary accounts and one owned VM.
// No AI credits, email, customer data, or real browser sessions are used.
const scenarios=[
  {enabled:process.env.RUN_LIVE_DSA_SUBMISSION==='1',mode:'dsa',activityId:'dsa-python-two-sum',source:dsaSolutions['dsa-python-two-sum'].JavaScript},
  {enabled:process.env.RUN_LIVE_CHALLENGE_SUBMISSION==='1',mode:'challenge',activityId:'challenge-javascript-performance',source:challengeSolution('challenge-javascript-performance')},
] as const
for(const scenario of scenarios)it.skipIf(!scenario.enabled)(`${scenario.mode}: persists trusted grades and immutable evidence through authenticated APIs`, async () => {
  const base = process.env.TEST_APP_URL ?? 'http://localhost:3112'
  if (!['localhost','127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Use the local application only.')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, secret = process.env.SUPABASE_SECRET_KEY!
  if (!url || !key || !secret) throw new Error('Load the configured Supabase environment.')
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(init?.signal ? [init.signal] : [])]) })
  const admin = createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: boundedFetch } })
  const users: string[] = [], clients: ReturnType<typeof createServerClient>[] = []
  let sandboxId: string | undefined
  type Account = { id: string; cookies: Map<string,string> }
  async function account(): Promise<Account> {
    const email = `grading-check-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    if (created.error || !created.data.user) throw new Error('Disposable account creation failed')
    users.push(created.data.user.id)
    const cookies = new Map<string,string>()
    const client = createServerClient(url,key,{ global: { fetch: boundedFetch }, cookies: {
      getAll: () => [...cookies].map(([name,value]) => ({name,value})),
      setAll: values => values.forEach(({name,value}) => cookies.set(name,value)),
    } })
    clients.push(client)
    if ((await client.auth.signInWithPassword({ email,password })).error) throw new Error('Disposable sign-in failed')
    return { id: created.data.user.id, cookies }
  }
  async function request(path: string, user?: Account, method='GET', value?: unknown, origin=base, signal?: AbortSignal) {
    return fetch(new URL(path,base),{method,redirect:'manual',signal:AbortSignal.any([AbortSignal.timeout(90_000),...(signal?[signal]:[])]),headers:{
      ...(user ? {cookie:[...user.cookies].map(([name,value])=>`${name}=${value}`).join('; '),'X-CodeTutor-Account':user.id}:{}),
      ...(method!=='GET' ? {'content-type':'application/json',origin}:{}),
    },...(value === undefined ? {}:{body:JSON.stringify(value)})})
  }
  async function body(response: Response, status=200) {
    const value = await response.json()
    if(response.status!==status) throw new Error(`Grading API ${response.status} ${value.error?.code ?? 'unknown'}; expected ${status}`)
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    return value
  }
  async function settleCaptures(user: Account) {
    const end=Date.now()+30_000
    while(Date.now()<end){
      const jobs=await admin.from('source_capture_jobs').select('id,state').eq('user_id',user.id).in('state',['queued','capturing','acknowledging'])
      if(jobs.error) throw new Error('Capture lookup failed')
      if(!jobs.data.length)return
      for(const job of jobs.data)await processSourceCapture(job.id)
      await pause(500)
    }
    throw new Error('Capture did not settle')
  }
  try {
    const a=await account(),b=await account(),{activityId,source,mode}=scenario
    const {project}=await body(await request('/api/projects',a,'POST',{title:'Disposable trusted grading',mode,activityId,language:'JavaScript'}),201)
    const created=await body(await request('/api/sandboxes',a,'POST',{projectId:project.id,ports:[3000],timeout:600_000}),201)
    sandboxId=created.sandboxId
    const vm=(await Sandbox.get({name:sandboxId!,resume:false,...getSandboxCredentials(),signal:AbortSignal.timeout(10_000)})).currentSession()
    await body(await request(`/api/sandboxes/${sandboxId}/files`,a,'PUT',{path:'src/main.mjs',content:source}))
    const input={projectId:project.id,activityId,sandboxId,language:'JavaScript',modelId:'openai/gpt-5-nano'}
    await body(await request('/api/activities/verify',undefined,'POST',input),401)
    await body(await request('/api/activities/verify',b,'POST',input),404)
    await body(await request('/api/activities/verify',a,'POST',input,'https://wrong.example'),403)
    await body(await request('/api/activities/verify',a,'POST',{...input,score:100}),400)
    // Deliberately alter only the disposable VM copy: grading must use the
    // captured server source, not the writable workspace or its test scripts.
    await vm.writeFiles([{path:'src/main.mjs',content:'export function solve(){return null}'}],{signal:AbortSignal.timeout(5000)})
    const correct=await body(await request('/api/activities/verify',a,'POST',input))
    expect(correct).toMatchObject({score:100,passed:true,aiAssessed:false})
    const history=`/api/projects/${project.id}/submissions`
    const stored=await body(await request(`${history}/${correct.submissionId}`,a))
    expect(stored).toMatchObject({score:100,passed:true,aiAssessed:false,state:'complete',sourceDigest:correct.sourceDigest})
    const retained = gradingSummarySchema.parse(stored.gradingSummary)
    expect(retained).toMatchObject({status:'complete',passedCount:24,caseCount:24,sourceDigest:correct.sourceDigest,compileFailure:null})
    if(mode==='challenge')expect(retained.checkVersion).toBe('challenges-v1')
    expect(retained.outcomes).toEqual(Array(24).fill('passed'))
    expect(stored).not.toHaveProperty('report')
    expect(correct).not.toHaveProperty('report')
    expect((await body(await request(`${history}/${correct.submissionId}?file=0`,a))).content).toBe(source)
    await body(await request(`${history}/${correct.submissionId}`,b),404)
    const assessment=await admin.from('assessments').select('verification_kind,ai_assessed,submission_id').eq('user_id',a.id).eq('submission_id',correct.submissionId).single()
    if(assessment.error)throw new Error('Assessment lookup failed')
    expect(assessment.data).toMatchObject({verification_kind:'command',ai_assessed:false})
    await settleCaptures(a)
    const current=await request(`/api/sandboxes/${sandboxId}/files?path=src/main.mjs`,a)
    expect(current.status).toBe(200)
    const revision=Number(current.headers.get('x-source-revision'))
    await body(await request(`/api/sandboxes/${sandboxId}/files`,a,'PUT',{path:'src/main.mjs',content:'export function solve(){return {passed:true,score:100}}',revision}))
    const incorrect=await body(await request('/api/activities/verify',a,'POST',input))
    expect(incorrect).toMatchObject({score:0,passed:false,aiAssessed:false})
    const failedEvidence=await body(await request(`${history}/${incorrect.submissionId}`,a))
    expect(gradingSummarySchema.parse(failedEvidence.gradingSummary)).toMatchObject({status:'complete',passedCount:0,caseCount:24})
    expect((await body(await request(`${history}/${correct.submissionId}?file=0`,a))).content).toBe(source)
    const list=await body(await request(history,a))
    expect(list.submissions).toHaveLength(2)
    expect(list.submissions.every((item:{aiAssessed:boolean})=>item.aiAssessed===false)).toBe(true)
    await settleCaptures(a)
    const beforeCancellation=await request(`/api/sandboxes/${sandboxId}/files?path=src/main.mjs`,a)
    expect(beforeCancellation.status).toBe(200)
    const runaway='export function solve(){ while(true){} }'
    await body(await request(`/api/sandboxes/${sandboxId}/files`,a,'PUT',{path:'src/main.mjs',content:runaway,revision:Number(beforeCancellation.headers.get('x-source-revision'))}))
    const cancelled=new AbortController()
    const pending=request('/api/activities/verify',a,'POST',input,base,cancelled.signal).then(
      ()=>'unexpected response',error=>error instanceof Error?error.name:'unknown error')
    let interruptedId:string|undefined
    try {
      await vi.waitFor(async()=>{
        const started=await admin.from('command_audits').select('request_id').eq('user_id',a.id).eq('origin','verification')
          .eq('status','running').not('command_id','is',null).maybeSingle()
        if(started.error)throw new Error('Command lookup failed')
        expect(started.data).not.toBeNull()
        interruptedId=started.data!.request_id
      },{timeout:20_000,interval:500})
    } finally {cancelled.abort()}
    expect(await pending).toBe('AbortError')
    await vi.waitFor(async()=>{
      const attempt=await admin.from('activity_submissions').select('state,failure_code').eq('user_id',a.id).eq('id',interruptedId!).single()
      if(attempt.error)throw new Error('Interrupted submission lookup failed')
      expect(attempt.data).toMatchObject({state:'failed',failure_code:'SUBMISSION_INTERRUPTED'})
      const command=await admin.from('command_audits').select('status,exit_code,finished_at').eq('user_id',a.id).eq('request_id',interruptedId!).single()
      if(command.error)throw new Error('Cancelled command lookup failed')
      // The capture worker can observe termination before the cancellation
      // request records it. The immutable first terminal observation may be
      // `done` (process ended, not a successful grade) with a nonzero exit.
      expect(['cancelled','done']).toContain(command.data.status)
      expect(Number.isInteger(command.data.exit_code)).toBe(true)
      expect(command.data.exit_code).not.toBe(0)
      expect(command.data.finished_at).not.toBeNull()
    },{timeout:15_000,interval:500})
    const guests=await vm.runCommand({cmd:'/usr/bin/pgrep',args:['-u','65534'],sudo:true,timeoutMs:2000,signal:AbortSignal.timeout(5000)})
    expect(guests.exitCode,'interruption leaves no grading subprocesses').toBe(1)
    expect(await body(await request(`${history}/${interruptedId}`,a))).toMatchObject({state:'failed',score:null,aiAssessed:null})
    expect((await body(await request(`${history}/${interruptedId}?file=0`,a))).content).toBe(runaway)
    await settleCaptures(a)
    await vm.stop({signal:AbortSignal.timeout(15_000)})
    const expired=await body(await request('/api/activities/verify',a,'POST',input),410)
    expect(expired.error.code).toBe('SANDBOX_EXPIRED')
    const expiredAttempt=await body(await request(`${history}/${expired.error.requestId}`,a))
    expect(expiredAttempt).toMatchObject({state:'failed',score:null,aiAssessed:null,failureCode:'SANDBOX_EXPIRED'})
    expect((await body(await request(`${history}/${correct.submissionId}?file=0`,a))).content).toBe(source)
    const afterExpiry=await body(await request(`${history}/${correct.submissionId}`,a))
    expect(afterExpiry.gradingSummary).toEqual(retained)
    // Export safe provenance after the VM is gone, not raw hidden checks.
    const archiveId=randomUUID()
    const archive=archiveReceiptSchema.parse(await body(await request(`/api/projects/${project.id}/archives`,a,'POST',{archiveId}),201))
    const records:Array<{kind:string;key:string;data:Record<string,unknown>}>=[]
    let cursor:number|null=0
    let payloadBytes=0
    while(cursor!==null){
      const page=archivePageSchema.parse(await body(await request(`/api/projects/${project.id}/archives/${archiveId}?after=${cursor}`,a)))
      payloadBytes+=await verifyArchivePage(archive,page,cursor)
      records.push(...page.records.map(envelope=>archiveRecordSchema.parse(JSON.parse(envelope.record))))
      cursor=page.nextCursor
    }
    expect(records.length).toBe(archive.recordCount)
    expect(payloadBytes).toBe(archive.payloadBytes)
    const exported=records.find(item=>item.kind==='submission'&&item.key===correct.submissionId)
    expect(exported,'archive includes the exact submitted attempt').toBeDefined()
    expect(exported?.data.gradingSummary).toEqual(retained)
    for(const record of records.filter(item=>item.kind==='submission')){
      expect(record.data).not.toHaveProperty('plan')
      expect(record.data).not.toHaveProperty('report')
    }
    await body(await request(`/api/projects/${project.id}/archives/${archiveId}`,a,'DELETE'))
    // The private quota table is intentionally not exposed by PostgREST. A
    // single service-only probe consumes the first AI daily counter for this
    // disposable account; 199 remaining proves grading consumed none before it.
    const aiQuota=await admin.rpc('consume_rate_limit',{p_user_id:a.id,p_bucket_key:'ai-day',p_limit:200,p_window_seconds:86400})
    if(aiQuota.error)throw new Error('Quota lookup failed')
    expect(aiQuota.data).toMatchObject([{allowed:true,remaining:199}])
    console.log('PASS: owned HTTP grading, retained private-check summaries, safe export after expiry, immutable source, spoofed-result rejection, cancellation without scores and no AI usage.')
  } finally {
    const errors:string[]=[],names=new Set(sandboxId?[sandboxId]:[])
    if(users.length){
      try {
        const rows=await admin.from('sandbox_sessions').select('id,sandbox_id').in('user_id',users)
        if(rows.error)errors.push('sandbox lookup')
        else rows.data.forEach(row=>names.add(row.sandbox_id ?? `codetutor-${row.id}`))
      } catch { errors.push('sandbox lookup') }
    }
    for(const name of names){try{const box=await Sandbox.get({name,resume:false,...getSandboxCredentials(),signal:AbortSignal.timeout(10_000)});await box.stop({signal:AbortSignal.timeout(15_000)})}catch(error){if(!isSandboxUnavailableError(error))errors.push('sandbox stop')}}
    for(const client of clients){try{if((await client.auth.signOut({scope:'global'})).error)errors.push('sign-out')}catch{errors.push('sign-out')}}
    for(const id of users){try{if((await admin.auth.admin.deleteUser(id)).error)errors.push('account removal')}catch{errors.push('account removal')}}
    if(errors.length)throw new Error(`Disposable cleanup needs attention: ${errors.join(', ')}`)
    console.log('Stopped disposable grading VM, signed out and removed temporary accounts/projects.')
  }
},300_000)
