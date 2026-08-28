'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { ActivityManifest } from '@/lib/learning/types'
import { hasTrustedChallengeGrader } from '@/lib/learning/challenges/contracts'

/** Read-only teaching material. Opening this never starts a VM or executes code. */
export function ActivityInstructions({ activity, language }: { activity: ActivityManifest; language?: string }) {
  const checks = (language ? activity.variants?.[language]?.verify : undefined) ?? activity.verify
  const trustedChallenge = activity.source === 'curated' && hasTrustedChallengeGrader(activity.id, language ?? activity.language)
  return <Dialog>
    <DialogTrigger asChild><Button size="sm" variant="outline">Instructions</Button></DialogTrigger>
    <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{activity.title}</DialogTitle>
        <DialogDescription>{activity.summary}</DialogDescription>
      </DialogHeader>
      {activity.lesson ? <section className="space-y-2 text-sm">
        <h2 className="font-semibold">Concept</h2>
        <p className="leading-6 text-muted-foreground">{activity.lesson.explanation}</p>
      </section> : null}
      <section className="space-y-2 text-sm">
        <h2 className="font-semibold">Your task</h2>
        <ol className="list-decimal space-y-3 pl-5">{activity.instructions.map((item, index) => <li key={index} className="leading-6">{item}</li>)}</ol>
      </section>
      {activity.milestones?.length ? <section className="space-y-3 text-sm" aria-labelledby="project-milestones-heading">
        <h2 id="project-milestones-heading" className="font-semibold">Project milestones</h2>
        <p className="text-muted-foreground">Record your checks and decisions in MILESTONES.md. This learner checklist does not award verified progress or a score.</p>
        <ol className="list-decimal space-y-4 pl-5">{activity.milestones.map(milestone => <li key={milestone.id} className="space-y-2">
          <h3 className="font-medium">{milestone.title}</h3>
          <p>{milestone.goal}</p>
          <ul className="list-disc space-y-1 pl-5">{milestone.acceptance.map(item => <li key={item}>{item}</li>)}</ul>
          <p className="text-xs text-muted-foreground">Run in the terminal:</p>
          <code className="block break-words rounded-md bg-muted p-3">{[milestone.check.executable, ...milestone.check.args].join(' ')}</code>
        </li>)}</ol>
      </section> : null}
      {activity.examples?.length ? <section className="space-y-2 text-sm">
        <h2 className="font-semibold">Examples</h2>
        {activity.examples.map((example, index) => <div key={index} className="rounded-md border border-border p-3">
          <p className="text-xs text-muted-foreground">Input</p><pre className="whitespace-pre-wrap break-words">{example.input}</pre>
          <p className="mt-2 text-xs text-muted-foreground">Expected</p><pre className="whitespace-pre-wrap break-words">{example.output}</pre>
        </div>)}
      </section> : null}
      {checks.kind === 'command' ? <section className="space-y-2 text-sm">
        <h2 className="font-semibold">{activity.mode === 'debug' ? 'Regression checks' : activity.mode === 'project' ? 'Project checks' : activity.mode === 'challenge' ? 'Challenge checks' : 'Practice checks'}</h2>
        <code className="block break-words rounded-md bg-muted p-3">{[checks.command.executable, ...checks.command.args].join(' ')}</code>
        <p className="text-muted-foreground">Run this in the terminal. Editable checks help you practice; passing them is not a trusted submission score.</p>
      </section> : null}
      {activity.lesson ? <>
        <section className="space-y-2 text-sm"><h2 className="font-semibold">Hints</h2>
          {activity.lesson.hints.map((hint, index) => <details key={index} className="rounded-md border border-border p-3"><summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">Hint {index + 1}</summary><p className="pt-2 leading-6 text-muted-foreground">{hint}</p></details>)}
        </section>
        <section className="space-y-2 text-sm"><h2 className="font-semibold">Reflect before submitting</h2>
          <p className="text-muted-foreground">{activity.mode === 'debug' ? 'Record your reproduction, root cause, repair and regression evidence in DIAGNOSIS.md. Write and save your concept answers in REFLECTION.md.' : 'Write and save your answers in REFLECTION.md.'}</p>
          <ul className="list-disc space-y-2 pl-5">{activity.lesson.reflectionQuestions.map(question => <li key={question}>{question}</li>)}</ul>
        </section>
      </> : null}
      {trustedChallenge ? <p className="text-xs text-muted-foreground">Submit runs 24 private server-owned behavioral checks against your saved entry file. All checks must pass for completion; reflection is not automatically scored. The check outcomes and submitted source are retained.</p> : activity.mode === 'practice' || activity.mode === 'debug' || activity.mode === 'challenge' || activity.mode === 'project' ? <p className="text-xs text-muted-foreground">{activity.mode === 'debug' ? 'Debug' : activity.mode === 'challenge' ? 'Challenge' : activity.mode === 'project' ? 'Project' : 'Practice'} submissions receive AI-assessed rubric feedback, not server-owned deterministic grading. Your saved submission source is retained with its assessment.</p> : null}
    </DialogContent>
  </Dialog>
}
