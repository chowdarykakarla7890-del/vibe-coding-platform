import 'fake-indexeddb/auto'
import { openDB } from 'idb'
import { describe, expect, it } from 'vitest'
import {
  importProject,
  listFileSnapshots,
  listProjects,
  listProgress,
  parseStoredChatMessages,
  saveFileSnapshot,
  saveFileSnapshots,
  saveProject,
  parseProjectExport,
} from '../lib/learning/local-db'
import { portfolioDocumentSchema, type LearningProject } from '../lib/learning/types'

describe('local learning persistence', () => {
  it('does not pass malformed saved project/progress fields into the UI or delete their records', async () => {
    await listProjects()
    const db = await openDB('codetutor-learning', 1)
    await db.put('projects', { id: 'broken-project', title: { invalid: true } })
    await db.put('progress', { activityId: 'broken-progress', concepts: null })
    expect((await listProjects()).some((project) => project.id === 'broken-project')).toBe(false)
    expect((await listProgress()).some((progress) => progress.activityId === 'broken-progress')).toBe(false)
    expect(await db.get('projects', 'broken-project')).toBeDefined()
    expect(await db.get('progress', 'broken-progress')).toBeDefined()
    db.close()
  })

  it('rejects a corrupt snapshot before its paths reach the file explorer', async () => {
    await listProjects()
    const db = await openDB('codetutor-learning', 1)
    await db.put('files', { id: 'corrupt:file', projectId: 'corrupt', path: null, content: 'recoverable content' })
    await expect(listFileSnapshots('corrupt')).rejects.toThrow(/snapshot is invalid/)
    expect(await db.get('files', 'corrupt:file')).toBeDefined()
    db.close()
  })
  it('keeps snapshots isolated when importing a project', async () => {
    const project: LearningProject = {
      id: crypto.randomUUID(),
      title: 'Original',
      mode: 'playground',
      language: 'TypeScript',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    }
    await saveProject(project)
    await saveFileSnapshot(project.id, 'src/index.ts', 'export const value = 1')
    const imported = await importProject({ version: 1, exportedAt: 2, project, files: await listFileSnapshots(project.id) })
    expect(imported.id).not.toBe(project.id)
    expect((await listFileSnapshots(imported.id))[0]?.content).toContain('value = 1')
  })

  it('rejects source files over 256 KB', async () => {
    expect(await saveFileSnapshot('project', 'large.txt', 'x'.repeat(262_145))).toBe(false)
  })

  it('rejects unsafe and oversized project imports', () => {
    const project: LearningProject = {
      id: 'original',
      title: 'Original',
      mode: 'playground',
      language: 'TypeScript',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    }
    const base = { version: 1 as const, exportedAt: 2, project }

    expect(() => parseProjectExport({ ...base, files: [{ path: '../secret', content: 'no' }] })).toThrow(/invalid/i)
    expect(() => parseProjectExport({ ...base, files: [{ path: '.env', content: 'TOKEN=secret' }] })).toThrow(/invalid/i)
    expect(() => parseProjectExport({ ...base, files: [{ path: 'src/bad\nname.ts', content: 'no' }] })).toThrow(/invalid/i)
    expect(() => parseProjectExport({
      ...base,
      files: Array.from({ length: 41 }, (_, index) => ({
        path: `src/file-${index}.txt`,
        content: 'x'.repeat(256 * 1024),
      })),
    })).toThrow(/10 MB/i)
  })

  it('does not restore stale sandbox credentials from an import', async () => {
    const project: LearningProject = {
      id: 'original-with-sandbox',
      title: 'Original',
      mode: 'playground',
      language: 'TypeScript',
      status: 'active',
      sandboxId: 'stale-sandbox',
      previewUrl: 'https://stale.vercel.run',
      createdAt: 1,
      updatedAt: 1,
    }
    const imported = await importProject({ version: 1, exportedAt: 2, project, files: [] })
    expect(imported.sandboxId).toBeUndefined()
    expect(imported.previewUrl).toBeUndefined()
  })

  it('stores a completed generation as one batch', async () => {
    const projectId = crypto.randomUUID()
    expect(
      await saveFileSnapshots(projectId, [
        { path: 'app/page.tsx', content: 'export default function Page() {}' },
        { path: 'app/layout.tsx', content: 'export default function Layout() {}' },
      ])
    ).toBe(2)
    expect((await listFileSnapshots(projectId)).map((file) => file.path).sort()).toEqual([
      'app/layout.tsx',
      'app/page.tsx',
    ])
  })

  it('drops malformed persisted chats instead of crashing project restore', async () => {
    await expect(parseStoredChatMessages(undefined)).resolves.toEqual([])
    await expect(parseStoredChatMessages([{ id: 'broken', role: 'assistant', parts: [] }])).resolves.toEqual([])
    await expect(parseStoredChatMessages([
      {
        id: 'message-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Restored safely' }],
      },
    ])).resolves.toEqual([
      {
        id: 'message-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Restored safely' }],
      },
    ])
  })

  it('salvages safe chat content while removing malformed legacy tool data', async () => {
    await expect(parseStoredChatMessages([
      {
        id: 'legacy-message',
        role: 'assistant',
        metadata: { model: { invalid: true } },
        parts: [
          { type: 'text', text: 'This explanation is still readable.' },
          {
            type: 'data-generating-files',
            data: { status: 'done' },
          },
          {
            type: 'tool-readFiles',
            toolCallId: 'legacy-tool',
            state: 'output-available',
            input: { paths: 'app/page.tsx' },
            output: 'legacy output',
          },
        ],
      },
    ])).resolves.toEqual([
      {
        id: 'legacy-message',
        role: 'assistant',
        metadata: undefined,
        parts: [
          { type: 'text', text: 'This explanation is still readable.' },
        ],
      },
    ])
  })

  it('validates portfolio links and screenshot formats before persistence', () => {
    const portfolio = {
      id: 'default' as const,
      displayName: 'Learner',
      headline: 'Builder',
      bio: '',
      skills: ['TypeScript'],
      projects: [{
        projectId: 'project-1',
        title: 'Project',
        summary: '',
        skills: ['TypeScript'],
        githubUrl: 'https://github.com/example/project',
      }],
      updatedAt: 1,
    }
    expect(portfolioDocumentSchema.safeParse(portfolio).success).toBe(true)
    expect(portfolioDocumentSchema.safeParse({
      ...portfolio,
      projects: [{ ...portfolio.projects[0], githubUrl: 'javascript:alert(1)' }],
    }).success).toBe(false)
    expect(portfolioDocumentSchema.safeParse({
      ...portfolio,
      projects: [{ ...portfolio.projects[0], screenshot: 'data:image/svg+xml;base64,PHN2Zz4=' }],
    }).success).toBe(false)
  })
})
