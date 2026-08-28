'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cloudOperation } from '@/lib/learning/cloud-request'
import { getApiErrorMessage } from '@/lib/api-error'
import { submissionDetailSchema, submissionsPageSchema, submittedFileSchema } from '@/lib/learning/submissions'
import type { GradingSummary } from '@/lib/learning/grading-evidence'
import { readWithDeadline } from '@/lib/abortable-read'

function useSubmissionRead<T>(url: string, schema: z.ZodType<T>) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    async function read() {
      try {
        const operation = cloudOperation(controller.signal)
        // The full read must settle even when a transport/body reader ignores
        // cancellation. Only publish after the deadline and account guards.
        const result = await readWithDeadline(async signal => {
          const response = await operation.fetch(url, { signal, cache: 'no-store' })
          const body: unknown = await response.json().catch(() => undefined)
          signal.throwIfAborted(); operation.assertActive()
          if (!response.ok) throw new Error(getApiErrorMessage(body, 'Submission history could not be loaded. Retry without clearing saved work.'))
          const parsed = schema.safeParse(body)
          if (!parsed.success) throw new Error('Submission history returned an invalid response.')
          return parsed.data
        }, operation.signal, 20_000, 'Loading submission history timed out. Your saved work is unchanged. Please retry.')
        operation.assertActive()
        setData(result); setError(undefined)
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load the submission.')
      }
    }
    void read()
    return () => controller.abort()
  }, [url, schema, version])
  return { data, error, retry: () => setVersion((value) => value + 1) }
}

export function SubmissionHistory({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false)
  return <>
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Submissions</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Submission history</DialogTitle>
          <DialogDescription>Each attempt retains the saved source it assessed. Unsaved editor or terminal changes are not included. These copies stay available after sandbox expiry.</DialogDescription>
        </DialogHeader>
        {open ? <SubmissionBrowser key={projectId} projectId={projectId} /> : null}
      </DialogContent>
    </Dialog>
  </>
}

function SubmissionBrowser({ projectId }: { projectId: string }) {
  const [selected, setSelected] = useState<string>()
  const [cursor, setCursor] = useState<string>()
  const endpoint = `/api/projects/${projectId}/submissions`
  return selected ? <>
    <Button variant="ghost" className="justify-self-start" onClick={() => setSelected(undefined)}>Back to submissions</Button>
    <SubmissionDetail key={selected} endpoint={`${endpoint}/${selected}`} />
  </> : <SubmissionPage key={cursor ?? 'first'} endpoint={endpoint} cursor={cursor} onSelect={setSelected} onPage={setCursor} />
}

function SubmissionPage({ endpoint, cursor, onSelect, onPage }: { endpoint: string; cursor?: string; onSelect: (id: string) => void; onPage: (cursor?: string) => void }) {
  const { data, error, retry } = useSubmissionRead(`${endpoint}${cursor ? `?after=${cursor}` : ''}`, submissionsPageSchema)
  return <>
    <Button variant="outline" className="justify-self-start" onClick={retry}>Refresh submissions</Button>
    {error ? <p role="alert">{error}</p> : !data ? <p role="status">Loading submissions…</p> : null}
    {data?.submissions.length === 0 ? <p className="text-sm text-muted-foreground">No retained submissions yet.</p> : null}
    <ul className="space-y-2">{data?.submissions.map((item) => <li key={item.id}>
      <Button variant="outline" className="h-auto w-full flex-wrap justify-between gap-2 whitespace-normal text-left" onClick={() => onSelect(item.id)}>
        <span>{new Date(item.createdAt).toLocaleString()} · {item.language}</span>
        <span>{item.score !== null ? `${item.score}% · ${item.aiAssessed === false ? 'Trusted checks' : item.aiAssessed === true ? 'AI assessed' : 'Assessment'}` : item.state === 'interrupted' ? 'Interrupted — no score' : item.state === 'failed' ? 'Failed — no score' : item.state === 'pending' ? 'Assessing…' : 'Complete'}</span>
      </Button>
    </li>)}</ul>
    <div className="flex gap-2">{cursor ? <Button variant="outline" onClick={() => onPage()}>First page</Button> : null}
      {data?.nextCursor ? <Button variant="outline" onClick={() => onPage(data.nextCursor!)}>Older submissions</Button> : null}</div>
  </>
}

export function SubmissionDetail({ endpoint }: { endpoint: string }) {
  const { data, error, retry } = useSubmissionRead(endpoint, submissionDetailSchema)
  const [fileIndex, setFileIndex] = useState(0)
  if (error) return <section role="alert"><p>{error}</p><Button className="mt-2" onClick={retry}>Retry submission</Button></section>
  if (!data) return <p role="status">Loading submitted source…</p>
  return <section className="min-w-0 space-y-3 text-sm">
    <h3 className="font-semibold">{data.title} · {data.language}</h3>
    <p>{data.score !== null ? `${data.score}% · ${data.aiAssessed === false ? 'Trusted checks' : data.aiAssessed === true ? 'AI assessed' : 'Assessment'}` : data.state === 'pending' ? 'Assessment is pending. Refresh history to check its outcome.' : 'This attempt has no saved score. Its source is retained.'}</p>
    {data.failureCode ? <p className="break-words text-muted-foreground">Reason: {data.failureCode.toLowerCase().replaceAll('_', ' ')}</p> : null}
    {data.sourceCurrentAtAssessment === false ? <p role="status">Newer source existed when this score was saved. This result applies only to the submitted copy below.</p> : null}
    <ul className="space-y-1 text-muted-foreground">{data.feedback.map((item, index) => <li key={index}>{item}</li>)}</ul>
    {data.gradingSummary ? <GradingEvidence summary={data.gradingSummary} />
      : data.aiAssessed === false ? <p className="text-muted-foreground">This older assessment has no retained check-by-check evidence. Its saved score and submitted source are unchanged.</p> : null}
    <label className="block" htmlFor={`submission-file-${data.id}`}>Submitted file</label>
    <select id={`submission-file-${data.id}`} className="w-full rounded-md border border-border bg-background p-2" value={fileIndex} onChange={(event) => setFileIndex(Number(event.target.value))}>
      {data.files.map((file, index) => <option key={file.path} value={index}>{file.path} · revision {file.revision}</option>)}
    </select>
    {data.files.length ? <SubmittedFile key={fileIndex} endpoint={`${endpoint}?file=${fileIndex}`} /> : null}
    <p className="break-all font-mono text-[10px] text-muted-foreground">Source digest: {data.sourceDigest}</p>
  </section>
}

function GradingEvidence({ summary }: { summary: GradingSummary }) {
  const labels = { passed: 'Passed', 'wrong-answer': 'Incorrect result', timeout: 'Timed out', 'output-limit': 'Output limit reached', 'execution-error': 'Execution failed', 'invalid-output': 'Invalid output' }
  return <section aria-label="Retained grading evidence" className="space-y-2 rounded-md border border-border p-3">
    <h4 className="font-medium">Retained grading evidence</h4>
    <p>{summary.status === 'prepared' ? `${summary.caseCount} checks retained; no complete grading result was recorded.`
      : summary.compileFailure ? `Compilation: ${labels[summary.compileFailure]}. No checks ran.`
        : `${summary.passedCount}/${summary.caseCount} checks passed.`}</p>
    <p className="text-xs text-muted-foreground">Check version: {summary.checkVersion}. Exact inputs and outputs are retained privately; hidden test data is not exposed here.</p>
    {summary.outcomes.length ? <details>
      <summary className="cursor-pointer focus-visible:outline focus-visible:outline-offset-2">Check-by-check outcomes</summary>
      <ol className="mt-2 grid gap-1 text-xs sm:grid-cols-2">{summary.outcomes.map((outcome, index) => <li key={index}>Check {index + 1}: {labels[outcome]}</li>)}</ol>
    </details> : null}
    <p className="break-all font-mono text-[10px] text-muted-foreground">Evidence digest: {summary.planDigest}</p>
  </section>
}

function SubmittedFile({ endpoint }: { endpoint: string }) {
  const { data, error, retry } = useSubmissionRead(endpoint, submittedFileSchema)
  if (error) return <section role="alert"><p>{error}</p><Button className="mt-2" onClick={retry}>Retry submitted file</Button></section>
  if (!data) return <p role="status">Loading file…</p>
  return <>
    <pre aria-label={`Submitted source: ${data.path}`} tabIndex={0} className="max-h-80 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs">{data.content}</pre>
    <Button variant="outline" onClick={() => {
      const url = URL.createObjectURL(new Blob([data.content], { type: 'text/plain;charset=utf-8' }))
      const link = document.createElement('a'); link.href = url; link.download = data.path.split('/').at(-1) ?? 'submitted-source.txt'; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }}>Download submitted file</Button>
  </>
}
