'use client'

import { ActivityHeader, CodeTutorWorkspace } from '@/components/workspace/code-tutor-workspace'
import { getGeneratedActivity, listFileSnapshots } from '@/lib/learning/db'
import { getActivity } from '@/lib/learning/catalog'
import { useLearning } from '@/lib/learning/learning-provider'
import type { ActivityManifest, ActivityMode, VerificationResult } from '@/lib/learning/types'
import { useSandboxStore } from '@/app/state'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getApiErrorMessage } from '@/lib/api-error'
import { z } from 'zod'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { SubmissionHistory } from './submission-history'
import { restoreProjectSandbox, SandboxReopenRequiredError } from '@/lib/learning/sandbox-recovery'
import { awaitMutationReceipt } from '@/lib/mutation-receipt'
import { readWithDeadline } from '@/lib/abortable-read'

const verificationResultSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  aiAssessed: z.boolean(),
  commandOutput: z.string(),
  feedback: z.array(z.string()),
  requestId: z.string(),
  submissionId: z.string().uuid().optional(),
  sourceDigest: z.string().optional(),
  sourceCurrent: z.boolean().optional(),
})

export function ActivityWorkspace({ activityId, mode }: { activityId: string; mode: ActivityMode }) {
  // App Router can preserve a client component across route-parameter changes.
  // The loaded manifest, initialization flag and result belong to one activity.
  return <ActivityWorkspaceSession key={`${mode}:${activityId}`} activityId={activityId} mode={mode} />
}

function ActivityWorkspaceSession({ activityId, mode }: { activityId: string; mode: ActivityMode }) {
  const [activity, setActivity] = useState<ActivityManifest | undefined>(() => getActivity(activityId))
  const { activeProject, createProject, isReady, projects, selectProject, updateProject, refreshProgress } = useLearning()
  const initialized = useRef(false)
  const setSandboxId = useSandboxStore((state) => state.setSandboxId)
  const dirtyFilePath = useSandboxStore((state) => state.dirtyFilePath)
  const addPaths = useSandboxStore((state) => state.addPaths)
  const [verificationRun, setVerificationRun] = useState<{ key: string }>()
  const verificationTask = useRef<AbortController | undefined>(undefined)
  const [verificationNotice, setVerificationNotice] = useState<{ key: string; message: string }>()
  const [startupPhase, setStartupPhase] = useState<'idle' | 'starting' | 'committing' | 'cancelling'>('idle')
  const starting = startupPhase !== 'idle'
  const startupTask = useRef<{ controller: AbortController; cancellable: boolean } | undefined>(undefined)
  const [startupError, setStartupError] = useState<string>()
  const [reopenRequired, setReopenRequired] = useState(false)
  const [assessment, setAssessment] = useState<{ key: string; result: VerificationResult }>()
  const [activityError, setActivityError] = useState(false)
  const [projectError, setProjectError] = useState<string>()
  const [projectRetry, setProjectRetry] = useState(0)
  const [activityLoaded, setActivityLoaded] = useState(Boolean(activity))
  const [loadVersion, setLoadVersion] = useState(0)
  const [language, setLanguage] = useState(activity?.language ?? 'Python')
  const mounted = useRef(true)
  const project = activeProject?.activityId === activityId
    ? activeProject
    : projects.find((item) => item.activityId === activityId)
  const selectedLanguage = project?.sandboxId ? project.language : activity?.variants ? language : activity?.language ?? language
  const verificationKey = `${activityId}:${activeProject?.id}:${project?.sandboxId}`
  const verifying = verificationRun?.key === verificationKey
  const result = assessment?.key === verificationKey ? assessment.result : undefined
  const notice = verificationNotice?.key === verificationKey ? verificationNotice.message : undefined
  const projectIsVisible = Boolean(project && activeProject?.id === project.id)
  const existingProjectId = projects.find(item => item.activityId === activityId)?.id
  const visibleProject = useRef(activeProject?.id)

  useEffect(() => {
    visibleProject.current = activeProject?.id
    return () => { startupTask.current?.controller.abort() }
  }, [activeProject?.id])

  useEffect(() => () => {
    verificationTask.current?.abort()
    verificationTask.current = undefined
  }, [verificationKey])

  useEffect(() => {
    if (activity) return
    const controller = new AbortController()
    void getGeneratedActivity(activityId, controller.signal).then((stored) => {
      if (!controller.signal.aborted) setActivityLoaded(true)
      if (!controller.signal.aborted && stored?.id === activityId && stored.mode === mode) {
        setActivity(stored)
        setLanguage(stored.language)
      }
    }).catch(() => { if (!controller.signal.aborted) setActivityError(true) })
    return () => {
      controller.abort()
    }
  }, [activity, activityId, mode, loadVersion])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (!activity || !isReady || initialized.current) return
    const controller = new AbortController()
    // Strict Mode's probe mount must not dispatch a create that its cleanup
    // immediately cancels while leaving the real mount marked initialized.
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted || initialized.current) return
      initialized.current = true
      if (existingProjectId) selectProject(existingProjectId)
      else await createProject({ title: activity.title, mode, activityId: activity.id, language: activity.language }, controller.signal)
    }).catch(error => {
      if (!controller.signal.aborted) setProjectError(error instanceof Error ? error.message : 'Could not create the activity project.')
    })
    return () => { controller.abort() }
  }, [activity, createProject, isReady, mode, existingProjectId, selectProject, projectRetry])

  async function startActivity() {
    if (!activity || !project || !projectIsVisible || startupTask.current || reopenRequired) return
    const variant = activity.variants?.[selectedLanguage]
    const starterFiles = variant?.starterFiles ?? activity.starterFiles
    const task = { controller: new AbortController(), cancellable: true }
    startupTask.current = task
    setStartupPhase('starting')
    setStartupError(undefined)
    let accountSignal: AbortSignal | undefined
    try {
      const account = cloudOperation()
      accountSignal = account.signal
      const result = await restoreProjectSandbox({
        projectId: project.id,
        signal: task.controller.signal,
        // Compiler installation can take longer than a plain source restore.
        timeoutMs: 120_000,
        loadFiles: async signal => {
          const saved = await listFileSnapshots(project.id, signal)
          if (saved.length && project.language !== selectedLanguage) {
            throw new Error(`This activity already has saved ${project.language} source. Select ${project.language} to continue without replacing it.`)
          }
          // A retry must never overwrite previous work with starter code.
          return saved.length ? saved : starterFiles.map(file => ({ ...file, revision: 0 }))
        },
        beforeCreate: signal => updateProject(project.id, { language: selectedLanguage }, signal),
        onCommitting: () => {
          task.cancellable = false
          if (mounted.current) setStartupPhase('committing')
        },
        commit: sandboxId => {
          account.assertActive()
          // Sandbox association comes from the server, not this client patch.
          return updateProject(project.id, { sandboxId, language: selectedLanguage }, account.signal)
        },
      })
      account.assertActive()
      if (!mounted.current || task.controller.signal.aborted || visibleProject.current !== project.id) return
      setSandboxId(result.sandboxId)
      addPaths(result.files.map(file => file.path))
      toast.success('Activity workspace is ready')
    } catch (error) {
      if (mounted.current && !accountSignal?.aborted && visibleProject.current === project.id) {
        setReopenRequired(error instanceof SandboxReopenRequiredError)
        setStartupError(error instanceof SandboxReopenRequiredError ? error.message : task.controller.signal.aborted
          ? 'Startup cancelled. Saved work has been kept. Any unconfirmed sandbox creation may still finish; reopen the project before retrying if it reports an active sandbox.'
          : error instanceof Error ? error.message : 'Could not start activity. Saved work has been kept.')
      }
    } finally {
      if (startupTask.current === task) {
        startupTask.current = undefined
        if (mounted.current) setStartupPhase('idle')
      }
    }
  }

  function cancelStartup() {
    const task = startupTask.current
    if (!task?.cancellable) return
    task.cancellable = false
    setStartupPhase('cancelling')
    task.controller.abort()
  }

  async function verifyActivity() {
    if (!activity || !project?.sandboxId || !projectIsVisible || verificationTask.current) return
    if (useSandboxStore.getState().dirtyFilePath) {
      toast.error('Save your editor changes before submitting. Your draft has not been changed.')
      return
    }
    const controller = new AbortController()
    verificationTask.current = controller
    setVerificationRun({ key: verificationKey })
    setAssessment(undefined)
    setVerificationNotice(undefined)
    let accountSignal: AbortSignal | undefined
    try {
      const operation = cloudOperation()
      accountSignal = operation.signal
      const signal = AbortSignal.any([controller.signal, operation.signal])
      // Submission is read-only with respect to source. Editor saves and the
      // server command-capture worker own persistence and revision conflicts.
      const verificationResult = await awaitMutationReceipt(async requestSignal => {
        const response = await operation.fetch('/api/activities/verify', {
          method: 'POST',
          signal: requestSignal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: project.id,
            activityId: activity.id,
            language: selectedLanguage,
            sandboxId: project.sandboxId,
          }),
        })
        const body: unknown = await response.json().catch(() => undefined)
        requestSignal.throwIfAborted()
        operation.assertActive()
        if (!response.ok) {
          throw new Error(getApiErrorMessage(body, 'Verification failed'))
        }
        const parsedResult = verificationResultSchema.safeParse(body)
        if (!parsedResult.success) {
          throw new Error('The verification response was invalid.')
        }
        return parsedResult.data
      }, signal, 160_000, 'Verification timed out. Check submission history before retrying; an assessment may already have been saved.')
      operation.assertActive()
      if (mounted.current && verificationTask.current === controller) {
        setAssessment({ key: verificationKey, result: verificationResult })
        toast[verificationResult.passed ? 'success' : 'error'](
          `${verificationResult.score}% — ${verificationResult.aiAssessed ? 'AI assessed' : 'trusted checks'}`
        )
      }
      // The API already committed the score and completion together. A failed
      // refresh must not encourage a duplicate submission of that saved attempt.
      await readWithDeadline(() => refreshProgress(), signal, 20_000, 'Progress refresh timed out.').catch(() => {
        if (!signal.aborted && mounted.current && verificationTask.current === controller) {
          toast.error('Your assessment was saved, but progress could not refresh. Reopen the activity to reload it.')
        }
      })
    } catch (error) {
      if (!controller.signal.aborted && !accountSignal?.aborted && mounted.current && verificationTask.current === controller) {
        const message = error instanceof Error ? error.message : 'Verification failed'
        setVerificationNotice({ key: verificationKey, message })
        toast.error(message)
      }
    } finally {
      if (verificationTask.current === controller) {
        verificationTask.current = undefined
        if (mounted.current) setVerificationRun(undefined)
      }
    }
  }

  function cancelVerification() {
    if (!verificationTask.current || result) return
    verificationTask.current.abort()
    setVerificationNotice({ key: verificationKey, message: 'Verification cancelled. Check submission history before retrying; cancellation does not remove an already-saved assessment.' })
  }

  if (!activity) {
    return <main className="grid h-full place-items-center p-6 text-sm text-muted-foreground">{activityError ? <section role="alert"><p>This activity could not be loaded. Your saved activity has not been changed.</p><button type="button" className="mt-3 underline" onClick={() => { setActivityError(false); setLoadVersion((value) => value + 1) }}>Retry activity</button></section> : activityLoaded ? 'Activity not found in your account.' : 'Opening activity…'}</main>
  }

  const needsStartup = !project?.sandboxId || starting
  const languagePicker = activity.variants ? (
    <label className="inline-flex items-center gap-2 text-xs">
      Template language
      <select
        className="h-8 rounded-md border border-border bg-background px-2 text-foreground disabled:opacity-50"
        disabled={starting || Boolean(project?.sandboxId)}
        onChange={event => setLanguage(event.target.value)}
        value={selectedLanguage}
      >
        {Object.keys(activity.variants).map(item => <option key={item} value={item}>{item}</option>)}
      </select>
    </label>
  ) : null

  return (
    <div className="relative h-full">
      {notice ? <aside role="alert" className="absolute right-5 top-28 z-20 max-w-sm rounded-lg border border-border bg-card p-4 text-xs shadow-xl"><p>{notice}</p><button className="mt-2 underline" onClick={() => setVerificationNotice(undefined)} type="button">Dismiss verification notice</button></aside> : null}
      <div className="h-full" inert={needsStartup}>
        <CodeTutorWorkspace activityHeader={<ActivityHeader activity={activity} language={selectedLanguage} action={<>{projectIsVisible && project ? <SubmissionHistory key={project.id} projectId={project.id} /> : null}{needsStartup ? null : languagePicker}<button className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50" title={dirtyFilePath ? 'Save your editor changes before submitting' : 'Assess an immutable copy of the saved project source'} disabled={needsStartup || !projectIsVisible || Boolean(dirtyFilePath) || verifying} onClick={() => void verifyActivity()} type="button">{verifying ? 'Verifying…' : 'Submit'}</button>{verifying && !result ? <button className="rounded-md border border-border px-3 py-1.5 text-xs" onClick={cancelVerification} type="button">Cancel verification</button> : null}</>} />} />
      </div>
      {result ? <div aria-live="polite" className="absolute right-5 top-28 z-20 max-w-sm rounded-lg border border-border bg-card p-4 text-xs shadow-xl"><div className="flex items-center justify-between"><strong>{result.score}% {result.passed ? 'Passed' : 'Needs work'}</strong><span className="text-muted-foreground">{result.aiAssessed ? 'AI assessed' : 'Trusted checks'}</span></div>{result.sourceCurrent === false ? <p className="mt-2">This score applies to the submitted version. Newer edits were not assessed.</p> : null}<ul className="mt-2 space-y-1 text-muted-foreground">{result.feedback.map((item) => <li key={item}>• {item}</li>)}</ul><button className="mt-2 underline" onClick={() => setAssessment(undefined)} type="button">Dismiss</button></div> : null}
      {needsStartup ? (
        <section aria-label="Activity startup" className="absolute inset-0 z-30 grid place-items-center overflow-y-auto bg-background/80 p-3 backdrop-blur-sm">
          <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-2xl">
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">{activity.mode} workspace</p>
            <h2 className="mt-2 text-xl font-semibold">{activity.title}</h2>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">Create an isolated sandbox and load the starter files. Saved source and learning history belong to your account; sandbox execution is temporary.</p>
            {languagePicker ? <div className="mt-4">{languagePicker}</div> : null}
            {projectError ? <section role="alert" className="mt-3 text-sm"><p>{projectError}</p><button className="mt-2 underline" type="button" onClick={() => { initialized.current = false; setProjectError(undefined); setProjectRetry((version) => version + 1) }}>Retry project creation</button></section> : null}
            {startupError ? <p role="alert" className="mt-3 text-sm">{startupError}</p> : null}
            {starting ? <p role="status" className="mt-3 text-sm">{startupPhase === 'cancelling' ? 'Cancelling startup…' : startupPhase === 'committing' ? 'Opening the saved workspace…' : 'Preparing the sandbox and loading saved source or starter files…'}</p> : null}
            <button className="mt-5 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50" disabled={starting || !projectIsVisible} onClick={() => {
              if (!reopenRequired) { void startActivity(); return }
              const draft = useSandboxStore.getState().dirtyFilePath
              if (draft && !window.confirm(`Reopening will discard the unsaved editor draft in ${draft}. Copy it first if needed. Reopen now?`)) return
              window.location.reload()
            }} type="button">{starting ? 'Starting…' : !projectIsVisible ? 'Opening project…' : reopenRequired ? 'Reopen project' : startupError ? 'Retry startup' : 'Start activity'}</button>
            {starting ? <button className="ml-3 underline disabled:opacity-50" disabled={startupPhase !== 'starting'} onClick={cancelStartup} type="button">Cancel startup</button> : null}
          </div>
        </section>
      ) : null}
    </div>
  )
}
