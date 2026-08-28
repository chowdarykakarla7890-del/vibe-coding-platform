'use client'

import { Chat } from '@/app/chat'
import { Header } from '@/app/header'
import { Workbench } from '@/app/workbench'
import { useLearning } from '@/lib/learning/learning-provider'
import type { ActivityManifest } from '@/lib/learning/types'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ActivityInstructions } from '@/components/learning/activity-instructions'

export function CodeTutorWorkspace({ activityHeader }: { activityHeader?: ReactNode }) {
  const [pane, setPane] = useState<'tutor' | 'workspace'>('tutor')
  return (
    <main className="flex h-full max-h-full min-h-0 flex-col overflow-hidden bg-background p-3 pt-14 md:pt-3">
      <Header className="h-10 shrink-0" />
      {activityHeader}
      <div role="group" aria-label="Workspace view" className="flex shrink-0 gap-2 pt-2 xl:hidden">
        <Button size="sm" variant="outline" aria-pressed={pane === 'tutor'} onClick={() => setPane('tutor')}>Tutor</Button>
        <Button size="sm" variant="outline" aria-pressed={pane === 'workspace'} onClick={() => setPane('workspace')}>Workspace</Button>
      </div>
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-1 gap-0 pt-3 xl:grid-cols-[minmax(320px,0.78fr)_minmax(520px,1.72fr)]">
        {/* CSS visibility keeps chat streams and unsaved editor drafts mounted. */}
        <Chat className={`min-h-0 min-w-0 overflow-hidden rounded-xl xl:rounded-r-none ${pane === 'tutor' ? 'flex' : 'hidden'} xl:flex`} />
        <Workbench className={`min-h-0 min-w-0 xl:rounded-l-none ${pane === 'workspace' ? 'flex' : 'hidden'} xl:flex`} />
      </div>
    </main>
  )
}

export function PlaygroundWorkspace() {
  const { activeProject, createProject, isReady, projects, selectProject } = useLearning()
  const initialized = useRef(false)
  const [startupError, setStartupError] = useState<string>()
  const [retryVersion, setRetryVersion] = useState(0)
  const existingProjectId = projects.find(project => project.mode === 'playground')?.id
  const activeMode = activeProject?.mode

  useEffect(() => {
    if (!isReady || initialized.current) return
    const controller = new AbortController()
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted || initialized.current) return
      initialized.current = true
      if (activeMode === 'playground') return
      if (existingProjectId) selectProject(existingProjectId)
      else await createProject({ title: 'My playground', mode: 'playground', language: 'Any' }, controller.signal)
    }).catch(error => {
      if (!controller.signal.aborted) setStartupError(error instanceof Error ? error.message : 'Could not create the project.')
    })
    return () => { controller.abort() }
  }, [activeMode, createProject, isReady, existingProjectId, selectProject, retryVersion])

  return <CodeTutorWorkspace activityHeader={startupError ? <aside role="alert" className="my-2 rounded-md border border-border p-3 text-sm"><p>{startupError}</p><Button className="mt-2" onClick={() => { initialized.current = false; setStartupError(undefined); setRetryVersion((version) => version + 1) }}>Retry project creation</Button></aside> : undefined} />
}

export function ActivityHeader({ activity, action, language }: { activity: ActivityManifest; action?: ReactNode; language?: string }) {
  const { progress } = useLearning()
  const record = progress.find(item => item.activityId === activity.id)
  // This is activity-wide saved progress, not a claim that the currently
  // edited source was submitted or that a failed/interrupted attempt scored.
  const progressLabel = record && record.attempts > 0 ? `Best: ${record.bestScore}%` : 'No scored attempts'
  return (
    <section className="mt-3 flex shrink-0 flex-wrap items-center gap-3 border border-border bg-card px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-sm font-medium">{activity.title}</h1>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">{activity.difficulty}</span>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{activity.framework ?? language ?? activity.language}</span>
        </div>
        <p className="mt-1 truncate text-muted-foreground">{activity.instructions[0]}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span>{activity.concepts.slice(0, 3).join(' · ')}</span>
        <span role="status" className="rounded-md bg-secondary px-2 py-1">{progressLabel}</span>
        <ActivityInstructions key={activity.id} activity={activity} language={language} />
        {action}
      </div>
    </section>
  )
}
