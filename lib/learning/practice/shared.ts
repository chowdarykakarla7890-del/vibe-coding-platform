import type { ActivityManifest } from '../types'

export interface LessonSpec {
  track: 'javascript' | 'typescript' | 'react' | 'python' | 'java' | 'cpp'
  stage: 'fundamentals' | 'data-flow' | 'composition'
  title: string
  summary: string
  concepts: string[]
  instructions: string[]
  explanation: string
  hints: string[]
  reflectionQuestions: string[]
  examples: { input: string; output: string }[]
  files: { path: string; content: string }[]
  command: { executable: string; args: string[] }
  preparation?: string
  quality: string
}

const languages = { javascript: 'JavaScript', typescript: 'TypeScript', react: 'JavaScript', python: 'Python', java: 'Java', cpp: 'C++' }
const levels = { fundamentals: ['beginner', 25], 'data-flow': ['intermediate', 40], composition: ['advanced', 55], 'state-bug': ['beginner', 25], 'edge-cases': ['advanced', 45], transform: ['beginner',30], validator: ['intermediate',50], performance: ['advanced',70] } as const

export type DebugLessonSpec = Omit<LessonSpec, 'stage'> & { stage: 'state-bug' | 'edge-cases' }
export type ChallengeLessonSpec = Omit<LessonSpec, 'stage'> & { stage: 'transform' | 'validator' | 'performance' }

export function practiceLesson(spec: LessonSpec): ActivityManifest {
  return guidedLesson(spec, 'practice')
}

export function debugLesson(spec: DebugLessonSpec): ActivityManifest {
  return guidedLesson(spec, 'debug')
}

export function challengeLesson(spec: ChallengeLessonSpec): ActivityManifest {
  return guidedLesson(spec, 'challenge')
}

function guidedLesson(spec: LessonSpec | DebugLessonSpec | ChallengeLessonSpec, mode: 'practice' | 'debug' | 'challenge'): ActivityManifest {
  const [difficulty, estimatedMinutes] = levels[spec.stage]
  const check = [spec.command.executable, ...spec.command.args].join(' ')
  const instructions = [
    ...spec.instructions,
    ...(spec.preparation ? [spec.preparation] : []),
    `Run ${check} in the terminal. ${mode === 'debug' ? 'Reproduce the failing check before changing code, identify its cause, and make a focused repair.' : 'The starter intentionally fails.'} Keep the supplied checks and add a boundary check of your own.`,
    `Answer ${mode === 'debug' ? 'DIAGNOSIS.md and ' : ''}REFLECTION.md, save your source, then Submit for AI rubric feedback. These editable practice checks are not tamper-proof or trusted grading.`,
  ]
  const lesson = { explanation: spec.explanation, hints: spec.hints, reflectionQuestions: spec.reflectionQuestions }
  return {
    id: `${mode}-${spec.track}-${spec.stage}`, mode,
    title: `${spec.track === 'react' ? 'React' : languages[spec.track]}: ${spec.title}`,
    summary: spec.summary, language: languages[spec.track],
    ...(spec.track === 'react' ? { framework: 'React' } : {}),
    difficulty, estimatedMinutes, concepts: spec.concepts, instructions, lesson,
    starterFiles: [...spec.files, ...(mode === 'debug' ? [{
      path: 'DIAGNOSIS.md', content: '# Bug diagnosis\n\n## Reproduction\n\nRecord the failing command, input, expected result and actual result before editing.\n\n## Root cause\n\nExplain the faulty expression or state transition, not just the symptom.\n\n## Focused repair\n\nExplain why the change fixes the cause without changing the contract.\n\n## Regression evidence\n\nRecord the check results after the repair and describe one added boundary case.\n',
    }] : []), {
      path: 'LESSON.md', content: `# ${spec.title}\n\n${spec.explanation}\n\n## Your task\n\n${instructions.map((item, i) => `${i + 1}. ${item}`).join('\n\n')}\n\n## Examples\n\n${spec.examples.map(item => `- ${item.input} → ${item.output}`).join('\n')}\n\n## Hints (try before opening)\n\n${spec.hints.map((hint, i) => `### Hint ${i + 1}\n\n${hint}`).join('\n\n')}\n`,
    }, {
      path: 'REFLECTION.md', content: `# Reflection\n\n${spec.reflectionQuestions.map(question => `## ${question}\n\nTODO: Write your explanation and a concrete example.`).join('\n\n')}\n`,
    }],
    verify: { kind: 'command', command: spec.command },
    rubric: [
      { id: 'behavior', label: 'Implements all stated behavior, including the documented boundary cases', weight: 60 },
      { id: 'design', label: spec.quality, weight: 20 },
      { id: 'checks', label: 'Preserves the supplied checks and adds a meaningful boundary check', weight: 10 },
      { id: 'reflection', label: mode === 'debug' ? 'DIAGNOSIS.md records cause, repair and regression evidence; REFLECTION.md explains the underlying concept' : 'REFLECTION.md explains the design and an edge case with concrete examples', weight: 10 },
    ],
    examples: spec.examples, source: 'curated',
  }
}

export function nodeFiles(source: string, imports: string, checks: [string, string][], typescript = false) {
  const extension = typescript ? 'ts' : 'mjs'
  return [
    { path: `src/main.${extension}`, content: source },
    { path: 'lesson.test.mjs', content: `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { ${imports} } from './src/main.${extension}'\n\n${checks.map(([name, body]) => `test(${JSON.stringify(name)}, () => {\n${body}\n})`).join('\n\n')}\n` },
    { path: 'package.json', content: JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test lesson.test.mjs', ...(typescript ? { typecheck: 'tsc --noEmit' } : {}) }, ...(typescript ? { devDependencies: { typescript: '5.9.3' } } : {}) }, null, 2) + '\n' },
    ...(typescript ? [{ path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true }, include: ['src/main.ts'] }, null, 2) + '\n' }] : []),
  ]
}

// This is an editable learner check runner, never the server's trusted grader.
// Temporary build output is outside source and removed after either outcome.
export function compiledRunner(language: 'Java' | 'C++') {
  const compile = language === 'Java' ? "['javac', '-d', build, 'Main.java', 'LessonTest.java']" : "['g++', '-std=c++17', '-Wall', '-Wextra', '-Werror', 'lesson_test.cpp', '-o', str(Path(build) / 'lesson')]"
  const run = language === 'Java' ? "['java', '-cp', build, 'LessonTest']" : "[str(Path(build) / 'lesson')]"
  return { path: 'check.py', content: `from pathlib import Path\nimport subprocess\nimport tempfile\n\nwith tempfile.TemporaryDirectory(prefix='codetutor-practice-') as build:\n    subprocess.run(${compile}, check=True, timeout=30, cwd=Path(__file__).parent)\n    subprocess.run(${run}, check=True, timeout=10, cwd=Path(__file__).parent)\n` }
}
