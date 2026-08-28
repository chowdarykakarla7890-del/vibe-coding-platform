'use client'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  BugIcon,
  BracesIcon,
  FileSearchIcon,
  GitCompareArrowsIcon,
  HelpCircleIcon,
  LightbulbIcon,
  ListChecksIcon,
  TextSearchIcon,
} from 'lucide-react'

interface Props {
  activeFile?: string
  className?: string
  disabled?: boolean
  onPrompt: (prompt: string) => void
  paths: string[]
}

export function CodeTutorActions({
  activeFile,
  className,
  disabled,
  onPrompt,
  paths,
}: Props) {
  const relevantPaths = paths
    .filter(
      (path) =>
        !/(^|\/)(node_modules|\.next|dist|build)(\/|$)|pnpm-lock\.yaml$/.test(
          path
        )
    )
    .slice(0, 16)

  const explainProject = () => {
    const fileHint =
      relevantPaths.length > 0
        ? ` Start with these files: ${relevantPaths.join(', ')}.`
        : ''

    onPrompt(
      `Act as my code tutor. Read the relevant source files in this project.${fileHint} ` +
        "Explain the entire codebase in a beginner-friendly walkthrough: start with the architecture, then explain each file's responsibility, and finally trace what happens when a user uses the app. Use short code excerpts only when they help. Do not modify any files. End with three quick comprehension questions."
    )
  }

  const explainFile = () =>
    onPrompt(
      activeFile
        ? `Read \`${activeFile}\` and teach it line by line. Explain the purpose of each section, how its data flows, and anything a beginner might find confusing. Do not modify the file. End by asking me to predict one small behavior.`
        : 'Ask me to choose a file in the editor, then explain how to read and understand that file.'
    )

  const explainLine = () =>
    onPrompt(
      activeFile
        ? `Read \`${activeFile}\`. I want a precise explanation of one line of code in this file. Ask me for the line number or pasted snippet first, then explain what it does, why it is written that way, and what would happen if it changed. Do not edit the file.`
        : 'Ask me to choose a file and provide a line number or code snippet. Then explain that line in plain language.'
    )

  const quizMe = () =>
    onPrompt(`Read the relevant implementation${
      activeFile ? `, starting with \`${activeFile}\`` : ''
    }, then give me a short code-reading quiz. Ask one question at a time, wait for my answer, and give a hint before revealing it. Do not modify files.`)

  const reviewChanges = () =>
    onPrompt(`Review my current code${
      activeFile ? `, starting with \`${activeFile}\`` : ''
    }. Read the relevant files first, then explain what changed, what is working well, and one specific improvement I can make. Do not edit files.`)

  const debugCode = () =>
    onPrompt(`Help me debug this project${
      activeFile ? `, starting with \`${activeFile}\`` : ''
    }. Read the relevant code, run the most useful existing check, and explain any failure in plain language. Give me one small fix to try, but do not edit my files.`)

  const giveHint = () =>
    onPrompt(`Give me one concise hint for the next useful step in this project${
      activeFile ? `, based on \`${activeFile}\`` : ''
    }. Read the relevant code first. Do not write the solution or edit files.`)

  const actions = [
    {
      icon: BracesIcon,
      label: 'Explain project',
      onClick: explainProject,
      description: 'Architecture and every key file',
    },
    {
      icon: FileSearchIcon,
      label: 'Explain file',
      onClick: explainFile,
      description: activeFile ?? 'Choose a file in the editor',
    },
    {
      icon: TextSearchIcon,
      label: 'Explain line',
      onClick: explainLine,
      description: 'Explain one exact line of code',
    },
    {
      icon: HelpCircleIcon,
      label: 'Quiz me',
      onClick: quizMe,
      description: 'Practice reading the code',
    },
    {
      icon: GitCompareArrowsIcon,
      label: 'Review changes',
      onClick: reviewChanges,
      description: 'Feedback on your current work',
    },
    {
      icon: BugIcon,
      label: 'Help debug',
      onClick: debugCode,
      description: 'Run a check and explain failures',
    },
    {
      icon: LightbulbIcon,
      label: 'Give a hint',
      onClick: giveHint,
      description: 'One next step, not the answer',
    },
  ]

  return (
    <section className={cn('border-t border-border bg-card px-2 py-2', className)}>
      <div className="mb-1.5 flex items-center gap-1.5 px-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        <ListChecksIcon className="size-3" /> Code tutor
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {actions.map(({ description, icon: Icon, label, onClick }) => (
          <Button
            className="h-auto min-w-0 flex-col items-start gap-1 rounded-md border-border bg-secondary/50 px-2 py-2 text-left hover:bg-secondary"
            disabled={disabled}
            key={label}
            onClick={onClick}
            variant="outline"
          >
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
              <Icon className="size-3.5 shrink-0 text-zinc-400" />
              {label}
            </span>
            <span className="w-full truncate text-[10px] font-normal text-muted-foreground">
              {description}
            </span>
          </Button>
        ))}
      </div>
    </section>
  )
}
