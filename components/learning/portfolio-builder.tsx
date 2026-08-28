'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useLearning } from '@/lib/learning/learning-provider'
import { loadPortfolio, savePortfolio } from '@/lib/learning/db'
import { portfolioDocumentSchema, type PortfolioDocument, type PortfolioProject } from '@/lib/learning/types'
import { DownloadIcon, EyeIcon, GithubIcon, PlusIcon, UploadIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import Image from 'next/image'

export function PortfolioBuilder() {
  const { projects } = useLearning()
  const [portfolio, setPortfolio] = useState<PortfolioDocument>()
  const [preview, setPreview] = useState(false)
  const [loadError, setLoadError] = useState<string>()
  const [loadVersion, setLoadVersion] = useState(0)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void loadPortfolio()
      .then((value) => {
        if (!cancelled) setPortfolio(value)
      })
      .catch((error) => {
        if (cancelled) return
        console.warn('Could not load portfolio', {
          errorName: error instanceof Error ? error.name : 'StorageError',
        })
        setLoadError(error instanceof Error ? error.message : 'Could not load the portfolio. Please retry.')
      })
    return () => {
      cancelled = true
    }
  }, [loadVersion])

  if (!portfolio) return <main className="grid h-full place-items-center p-6 text-sm text-muted-foreground"><div role="status">{loadError ? <><p>{loadError}</p><Button className="mt-3" onClick={() => { setLoadError(undefined); setLoadVersion((version) => version + 1) }}>Retry loading portfolio</Button></> : 'Loading saved portfolio…'}</div></main>
  const currentPortfolio = portfolio

  async function save(next = currentPortfolio) {
    if (!next || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const value = portfolioDocumentSchema.parse({ ...next, updatedAt: Date.now() })
      setPortfolio(value)
      await savePortfolio(value)
      toast.success('Portfolio saved to your account')
    } catch (error) {
      toast.error(error instanceof Error && !('issues' in error) ? error.message : 'Check text limits, links, and screenshots before saving')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  function update(patch: Partial<PortfolioDocument>) {
    setPortfolio((current) => current ? { ...current, ...patch } : current)
  }

  function addProject(projectId: string) {
    if (!projectId || currentPortfolio.projects.some((item) => item.projectId === projectId)) return
    const project = projects.find((item) => item.id === projectId)
    if (!project) return
    update({ projects: [...currentPortfolio.projects, { projectId, title: project.title, summary: '', skills: project.language === 'Any' ? [] : [project.language] }] })
  }

  function updateProject(projectId: string, patch: Partial<PortfolioProject>) {
    update({ projects: currentPortfolio.projects.map((item) => item.projectId === projectId ? { ...item, ...patch } : item) })
  }

  function addScreenshot(projectId: string, file?: File) {
    if (!file) return
    if (file.size > 1_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Choose a PNG, JPEG, or WebP image under 1 MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => updateProject(projectId, { screenshot: String(reader.result) })
    reader.readAsDataURL(file)
  }

  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(currentPortfolio, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'codetutor-portfolio.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function importFile(file?: File) {
    if (!file) return
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Portfolio export exceeds the 5 MB import limit')
      const value = portfolioDocumentSchema.parse(JSON.parse(await file.text()) as unknown)
      await save({ ...value, updatedAt: Date.now() })
    } catch (error) {
      toast.error(error instanceof Error && !('issues' in error) ? error.message : 'Invalid portfolio export')
    } finally {
      if (importRef.current) importRef.current.value = ''
    }
  }

  return (
    <main className="h-full overflow-y-auto px-5 py-16 md:px-8 md:py-8 lg:px-12">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-7">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Private portfolio</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Portfolio builder</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">Curate projects, skills, screenshots, GitHub links, and permanent demo URLs. Nothing is published automatically.</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setPreview((value) => !value)} variant="outline"><EyeIcon className="size-4" />{preview ? 'Edit' : 'Preview'}</Button>
            <Button disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</Button>
          </div>
        </header>

        {preview ? (
          <PortfolioPreview portfolio={portfolio} />
        ) : (
          <div className="mt-7 grid gap-7 lg:grid-cols-[0.75fr_1.25fr]">
            <section className="space-y-4 rounded-xl border border-border bg-card p-5">
              <h2 className="text-sm font-medium">Profile</h2>
              <Field label="Display name" onChange={(value) => update({ displayName: value })} value={portfolio.displayName} />
              <Field label="Headline" onChange={(value) => update({ headline: value })} value={portfolio.headline} />
              <label className="block text-xs text-muted-foreground">Bio<textarea className="mt-1 min-h-28 w-full rounded-md border border-border bg-background p-3 text-sm text-foreground" onChange={(event) => update({ bio: event.target.value })} value={portfolio.bio} /></label>
              <Field label="Skills (comma separated)" onChange={(value) => update({ skills: value.split(',').map((item) => item.trim()).filter(Boolean) })} value={portfolio.skills.join(', ')} />
              <div className="flex gap-2 pt-2">
                <Button onClick={download} size="sm" variant="outline"><DownloadIcon className="size-3.5" />Export JSON</Button>
                <Button onClick={() => importRef.current?.click()} size="sm" variant="outline"><UploadIcon className="size-3.5" />Import</Button>
                <input accept="application/json,.json" className="sr-only" onChange={(event) => void importFile(event.target.files?.[0])} ref={importRef} type="file" />
              </div>
            </section>
            <section>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-sm font-medium">Featured projects</h2>
                <select className="h-9 rounded-md border border-border bg-card px-3 text-xs" defaultValue="" onChange={(event) => { addProject(event.target.value); event.target.value = '' }}>
                  <option disabled value="">Add a saved project…</option>
                  {projects.filter((project) => !portfolio.projects.some((item) => item.projectId === project.id)).map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
                </select>
              </div>
              <div className="space-y-3">
                {portfolio.projects.map((project) => (
                  <article className="rounded-xl border border-border bg-card p-5" key={project.projectId}>
                    <div className="flex items-center justify-between gap-3">
                      <Input className="font-medium" onChange={(event) => updateProject(project.projectId, { title: event.target.value })} value={project.title} />
                      <Button onClick={() => update({ projects: portfolio.projects.filter((item) => item.projectId !== project.projectId) })} size="sm" variant="ghost">Remove</Button>
                    </div>
                    <textarea className="mt-3 min-h-20 w-full rounded-md border border-border bg-background p-3 text-sm" onChange={(event) => updateProject(project.projectId, { summary: event.target.value })} placeholder="What did you build and learn?" value={project.summary} />
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field label="GitHub URL" onChange={(value) => updateProject(project.projectId, { githubUrl: value.trim() || undefined })} value={project.githubUrl ?? ''} />
                      <Field label="Permanent demo URL" onChange={(value) => updateProject(project.projectId, { demoUrl: value.trim() || undefined })} value={project.demoUrl ?? ''} />
                    </div>
                    <label className="mt-3 inline-flex cursor-pointer items-center rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
                      {project.screenshot ? 'Replace screenshot' : 'Add screenshot'}
                      <input accept="image/*" className="sr-only" onChange={(event) => addScreenshot(project.projectId, event.target.files?.[0])} type="file" />
                    </label>
                  </article>
                ))}
                {!portfolio.projects.length ? <div className="grid min-h-52 place-items-center rounded-xl border border-dashed border-border text-center text-sm text-muted-foreground"><div><PlusIcon className="mx-auto mb-2 size-5" />Add one of your saved projects to begin.</div></div> : null}
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  )
}

function Field({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return <label className="block text-xs text-muted-foreground">{label}<Input className="mt-1 text-foreground" onChange={(event) => onChange(event.target.value)} value={value} /></label>
}

function PortfolioPreview({ portfolio }: { portfolio: PortfolioDocument }) {
  return <div className="mx-auto mt-10 max-w-4xl rounded-2xl border border-border bg-card p-7 md:p-12">
    <p className="font-mono text-xs uppercase tracking-widest text-blue-400">Portfolio preview</p>
    <h2 className="mt-4 text-4xl font-semibold">{portfolio.displayName || 'Your name'}</h2>
    <p className="mt-2 text-xl text-muted-foreground">{portfolio.headline}</p>
    <p className="mt-6 max-w-2xl leading-7 text-muted-foreground">{portfolio.bio || 'Add a short bio in the editor.'}</p>
    <div className="mt-5 flex flex-wrap gap-2">{portfolio.skills.map((skill) => <span className="rounded-full bg-secondary px-3 py-1 text-xs" key={skill}>{skill}</span>)}</div>
    <div className="mt-12 grid gap-4 md:grid-cols-2">{portfolio.projects.map((project) => <article className="overflow-hidden rounded-xl border border-border" key={project.projectId}>{project.screenshot ? <Image alt={`Screenshot of ${project.title}`} className="aspect-video w-full object-cover" height={360} src={project.screenshot} unoptimized width={640} /> : null}<div className="p-5"><h3 className="text-lg font-medium">{project.title}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{project.summary || 'Project summary coming soon.'}</p><div className="mt-4 flex gap-3 text-xs">{project.githubUrl ? <a className="flex items-center gap-1 underline" href={project.githubUrl} rel="noopener noreferrer" target="_blank"><GithubIcon className="size-3" />GitHub</a> : null}{project.demoUrl ? <a className="underline" href={project.demoUrl} rel="noopener noreferrer" target="_blank">Live demo</a> : null}</div></div></article>)}</div>
  </div>
}
