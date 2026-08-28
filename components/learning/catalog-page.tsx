'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLearning } from '@/lib/learning/learning-provider'
import { type ActivityManifest, type ActivityMode, type Difficulty } from '@/lib/learning/types'
import { cn } from '@/lib/utils'
import { ArrowRightIcon, Clock3Icon, PlusIcon, SparklesIcon } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { calculateMastery } from '@/lib/learning/scoring'
import { listGeneratedActivities } from '@/lib/learning/db'
import { readWithDeadline } from '@/lib/abortable-read'
import { generateActivity } from '@/lib/learning/generate-activity'

const routeByMode: Record<ActivityMode, string> = {
  practice: 'practice',
  debug: 'debug',
  challenge: 'challenges',
  project: 'projects',
  dsa: 'dsa',
}

const copy: Record<ActivityMode, { eyebrow: string; title: string; description: string }> = {
  practice: { eyebrow: 'Guided learning', title: 'Practice', description: 'Learn a concept, complete focused TODOs, run checks, and reflect on what changed.' },
  debug: { eyebrow: 'Diagnosis lab', title: 'Debug', description: 'Reproduce failures, isolate root causes, make targeted repairs, and prove regressions are covered.' },
  challenge: { eyebrow: 'Scored exercises', title: 'Challenges', description: 'Solve concise tasks, submit against edge-case checks, and improve your best score.' },
  project: { eyebrow: 'Build end to end', title: 'Projects', description: 'Follow multi-step blueprints across six toolchains or generate a project around your own goal.' },
  dsa: { eyebrow: 'Algorithms & data structures', title: 'DSA', description: 'Practice fifteen foundational problems with templates, complexity guidance, and verification.' },
}

export function CatalogPage({ activities: curatedActivities, mode }: { activities: ActivityManifest[]; mode: ActivityMode }) {
  const router = useRouter()
  const { progress, activeProjectId } = useLearning()
  const [difficulty, setDifficulty] = useState<Difficulty | 'all'>('all')
  const [generating, setGenerating] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customGoal, setCustomGoal] = useState('')
  const [customLanguage, setCustomLanguage] = useState('TypeScript')
  const generationController = useRef<AbortController | null>(null)
  const [generatedActivities, setGeneratedActivities] = useState<ActivityManifest[]>([])
  const [activityLoadError, setActivityLoadError] = useState(false)
  const [loadVersion, setLoadVersion] = useState(0)
  const [generationNotice, setGenerationNotice] = useState<string>()
  const activities = useMemo(() => [...curatedActivities, ...generatedActivities.filter((item) => item.mode === mode)], [curatedActivities, generatedActivities, mode])

  useEffect(() => {
    const controller = new AbortController()
    void readWithDeadline(listGeneratedActivities, controller.signal, 15_000, 'Loading saved activities timed out.')
      .then((stored) => { if (!controller.signal.aborted) { setGeneratedActivities(stored); setActivityLoadError(false) } })
      .catch(() => { if (!controller.signal.aborted) setActivityLoadError(true) })
    return () => controller.abort()
  }, [loadVersion])

  useEffect(
    () => () => {
      generationController.current?.abort()
    },
    [mode, activeProjectId]
  )
  const details = copy[mode]
  const visible = useMemo(
    () => difficulty === 'all' ? activities : activities.filter((activity) => activity.difficulty === difficulty),
    [activities, difficulty]
  )
  const progressById = useMemo(() => new Map(progress.map((record) => [record.activityId, record])), [progress])
  const modeProgress = useMemo(
    () => activities.flatMap((activity) => {
      const record = progressById.get(activity.id)
      return record ? [{ ...record, difficulty: activity.difficulty }] : []
    }),
    [activities, progressById]
  )
  const completed = modeProgress.filter((record) => record.completed).length
  const mastery = calculateMastery(modeProgress)
  const recommended = activities.find((activity) => !progressById.get(activity.id)?.completed)

  async function generateCustom() {
    if (customGoal.trim().length < 5 || !customLanguage.trim() || generationController.current) return
    const controller = new AbortController()
    generationController.current = controller
    setGenerating(true)
    setGenerationNotice(undefined)
    try {
      const activity = await generateActivity({ mode, goal: customGoal, language: customLanguage, difficulty: difficulty === 'all' ? 'intermediate' : difficulty }, controller.signal)
      if (controller.signal.aborted || generationController.current !== controller) return
      setCustomOpen(false)
      router.push(`/${routeByMode[mode]}/${activity.id}`)
    } catch (error) {
      if (!controller.signal.aborted && generationController.current === controller && !(error instanceof Error && error.name === 'AbortError')) {
        setGenerationNotice(error instanceof Error ? error.message : 'Could not generate activity.')
      }
    } finally {
      if (generationController.current === controller) {
        generationController.current = null
        setGenerating(false)
      }
    }
  }

  function setCustomDialogOpen(open: boolean) {
    setCustomOpen(open)
    if (!open && generationController.current) {
      const pending = generationController.current
      generationController.current = null
      pending.abort()
      setGenerating(false)
      setGenerationNotice('Generation stopped. A request already sent may still finish and be saved to your account.')
    }
  }

  const generationRecovery = generationNotice ? (
    <aside role="alert" className="rounded-md border border-border p-3 text-sm">
      <p>{generationNotice}</p>
      <p className="mt-2 text-muted-foreground">No automatic retry was started. Check saved activities before generating again.</p>
      <Button className="mt-2" size="sm" type="button" variant="outline" onClick={() => { setCustomDialogOpen(false); setLoadVersion(value => value + 1) }}>Reload saved activities</Button>
    </aside>
  ) : null

  return (
    <main className="h-full overflow-y-auto px-5 py-16 md:px-8 md:py-8 lg:px-12">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-6 border-b border-border pb-8 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{details.eyebrow}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">{details.title}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">{details.description}</p>
          </div>
          <Button disabled={generating} onClick={() => setCustomOpen(true)}>
            <SparklesIcon className="size-4" />
            {generating ? 'Generating…' : 'Custom activity'}
          </Button>
        </header>

        {activityLoadError ? <aside role="alert" className="mt-4 rounded-md border border-border p-3 text-sm"><p>Saved custom activities could not be loaded. Your account data has not been changed.</p><Button className="mt-2" size="sm" variant="outline" onClick={() => { setActivityLoadError(false); setLoadVersion((value) => value + 1) }}>Retry saved activities</Button></aside> : null}
        {!customOpen && generationRecovery ? <div className="mt-4">{generationRecovery}</div> : null}

        <section aria-label="Learning progress" className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border bg-card p-4"><div className="font-mono text-[10px] uppercase text-muted-foreground">Completed</div><div className="mt-1 text-xl font-medium">{completed}/{activities.length}</div></div>
          <div className="rounded-lg border border-border bg-card p-4"><div className="font-mono text-[10px] uppercase text-muted-foreground">Mastery</div><div className="mt-1 text-xl font-medium">{mastery}%</div></div>
          <div className="rounded-lg border border-border bg-card p-4"><div className="font-mono text-[10px] uppercase text-muted-foreground">Recommended next</div>{recommended ? <Link className="mt-1 flex items-center justify-between text-sm hover:underline" href={`/${routeByMode[mode]}/${recommended.id}`}><span className="truncate">{recommended.title}</span><ArrowRightIcon className="size-3.5 shrink-0" /></Link> : <div className="mt-1 text-sm">Track complete</div>}</div>
        </section>

        <div className="my-6 flex flex-wrap items-center gap-2">
          {(['all', 'beginner', 'intermediate', 'advanced'] as const).map((item) => (
            <Button className="capitalize" key={item} onClick={() => setDifficulty(item)} size="sm" variant={difficulty === item ? 'secondary' : 'ghost'}>{item}</Button>
          ))}
          <span className="ml-auto font-mono text-xs text-muted-foreground">{visible.length} activities</span>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((activity) => {
            const record = progressById.get(activity.id)
            return (
              <Link
                className="group flex min-h-56 flex-col rounded-xl border border-border bg-card p-5 transition-colors hover:border-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={`/${routeByMode[mode]}/${activity.id}`}
                key={activity.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="rounded-full bg-secondary px-2 py-1 font-mono text-[10px] uppercase text-muted-foreground">{activity.difficulty}</span>
                  {record ? <span className={cn('font-mono text-xs', record.completed ? 'text-blue-400' : 'text-muted-foreground')}>{record.bestScore}% best</span> : null}
                </div>
                <h2 className="mt-5 text-lg font-medium tracking-tight">{activity.title}</h2>
                <p className="mt-2 line-clamp-3 text-sm leading-5 text-muted-foreground">{activity.summary}</p>
                <div className="mt-auto flex items-end justify-between pt-6">
                  <div>
                    <div className="text-xs text-muted-foreground">{activity.concepts.slice(0, 2).join(' · ')}</div>
                    <div className="mt-1 flex items-center gap-1 font-mono text-[10px] text-muted-foreground"><Clock3Icon className="size-3" />{activity.estimatedMinutes} min</div>
                  </div>
                  <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-foreground" />
                </div>
              </Link>
            )
          })}
          <button disabled={generating} className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 p-5 text-muted-foreground hover:border-zinc-500 hover:text-foreground disabled:opacity-50" onClick={() => setCustomOpen(true)} type="button">
            <PlusIcon className="mb-3 size-6" />
            <span className="text-sm font-medium">Generate another path</span>
          </button>
        </div>
      </div>
      <Dialog
        onOpenChange={setCustomDialogOpen}
        open={customOpen}
      >
        <DialogContent>
          <DialogHeader><DialogTitle>Generate a custom {details.title.toLowerCase()} activity</DialogTitle><DialogDescription>Describe a focused outcome. The generated activity is validated and saved to your account before it opens. Generation uses your AI quota.</DialogDescription></DialogHeader>
          {generationRecovery}
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void generateCustom() }}>
            <label className="block text-xs text-muted-foreground">Learning goal<textarea autoFocus className="mt-1 min-h-28 w-full rounded-md border border-border bg-background p-3 text-sm text-foreground" maxLength={800} onChange={(event) => setCustomGoal(event.target.value)} placeholder="Build a pagination component and learn how cursor-based navigation works" value={customGoal} /></label>
            <label className="block text-xs text-muted-foreground">Language or framework<Input className="mt-1 text-foreground" maxLength={40} onChange={(event) => setCustomLanguage(event.target.value)} value={customLanguage} /></label>
            {generating ? <p role="status" aria-live="polite" className="text-sm text-muted-foreground">Creating your activity… You can cancel while it is running.</p> : null}
            <DialogFooter><Button onClick={() => setCustomDialogOpen(false)} type="button" variant="outline">Cancel</Button><Button disabled={generating || customGoal.trim().length < 5 || !customLanguage.trim()} type="submit">{generating ? 'Generating…' : 'Generate activity'}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  )
}
