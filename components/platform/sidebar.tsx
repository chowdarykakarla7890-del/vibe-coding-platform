'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  BugIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Code2Icon,
  FolderKanbanIcon,
  ListChecksIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  ShieldCheckIcon,
  TrophyIcon,
  WaypointsIcon,
  XIcon,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useId, useState, type ReactNode } from 'react'
import type { MouseEvent } from 'react'
import { useSandboxStore } from '@/app/state'
import { readLocalPreference, writeLocalPreference } from '@/lib/local-preferences'

const sections = [
  {
    label: 'Code',
    items: [
      { href: '/playground', label: 'Playground', icon: Code2Icon },
      { href: '/practice', label: 'Practice', icon: ListChecksIcon },
      { href: '/debug', label: 'Debug', icon: BugIcon },
      { href: '/challenges', label: 'Challenges', icon: TrophyIcon },
    ],
  },
  {
    label: 'Build',
    items: [
      { href: '/projects', label: 'Projects', icon: FolderKanbanIcon },
      { href: '/dsa', label: 'DSA', icon: WaypointsIcon },
      { href: '/portfolio', label: 'Portfolio', icon: ShieldCheckIcon },
    ],
  },
] as const

export function PlatformShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const dirtyFilePath = useSandboxStore((state) => state.dirtyFilePath)
  const setDirtyFilePath = useSandboxStore((state) => state.setDirtyFilePath)

  function handleNavigation(event: MouseEvent<HTMLAnchorElement>) {
    // Opening another tab/window must not discard this workspace's draft.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (new URL(event.currentTarget.href).pathname === window.location.pathname) {
      setMobileOpen(false)
      return
    }
    if (
      dirtyFilePath &&
      !window.confirm(`Discard unsaved changes in ${dirtyFilePath}?`)
    ) {
      event.preventDefault()
      return
    }
    setDirtyFilePath(undefined)
    setMobileOpen(false)
  }

  useEffect(() => {
    const timer = window.setTimeout(
      () => setCollapsed(readLocalPreference('codetutor-sidebar-collapsed') === '1'),
      0
    )
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)')
    const closeOnDesktop = () => { if (desktop.matches) setMobileOpen(false) }
    desktop.addEventListener('change', closeOnDesktop)
    return () => desktop.removeEventListener('change', closeOnDesktop)
  }, [])

  function toggleCollapsed() {
    const next = !collapsed
    setCollapsed(next)
    writeLocalPreference('codetutor-sidebar-collapsed', next ? '1' : '0')
  }

  return (
    <div className="flex h-dvh min-h-0 bg-background">
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogTrigger asChild>
          <Button aria-label="Open navigation" className="fixed left-3 top-3 z-40 md:hidden" size="icon" variant="outline">
            <MenuIcon className="size-4" />
          </Button>
        </DialogTrigger>
        <DialogContent
          aria-describedby={undefined}
          showCloseButton={false}
          className="inset-y-0 left-0 top-0 flex h-dvh max-h-dvh w-[238px] max-w-[calc(100vw-2rem)] translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-r border-border bg-card p-0 sm:max-w-[238px] motion-reduce:animate-none"
        >
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-3">
            <Link aria-label="CodeTutor home" href="/playground" onClick={handleNavigation}>CodeTutor</Link>
            <DialogClose asChild>
              <Button aria-label="Close navigation" size="icon" variant="ghost"><XIcon className="size-4" /></Button>
            </DialogClose>
          </div>
          <Navigation collapsed={false} onNavigate={handleNavigation} />
        </DialogContent>
      </Dialog>
      <aside
        aria-label="Desktop navigation"
        className={cn(
          'hidden w-[238px] shrink-0 flex-col border-r border-border bg-card md:flex',
          collapsed && 'w-16'
        )}
      >
        <div className={cn('flex h-16 items-center border-b border-border px-3', collapsed ? 'justify-center' : 'justify-between')}>
          <Link aria-label="CodeTutor home" className="flex items-center gap-2" href="/playground" onClick={handleNavigation}>
            <span className="grid size-8 place-items-center rounded-lg border border-border bg-secondary">
              <Code2Icon className="size-4" />
            </span>
            {!collapsed ? <span className="font-medium tracking-tight">CodeTutor</span> : null}
          </Link>
        </div>
        <Navigation collapsed={collapsed} onNavigate={handleNavigation} />
        <div className="border-t border-border p-2">
          <Button
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn('w-full', collapsed ? 'px-0' : 'justify-start')}
            onClick={toggleCollapsed}
            variant="ghost"
          >
            {collapsed ? <PanelLeftOpenIcon className="size-4" /> : <PanelLeftCloseIcon className="size-4" />}
            {!collapsed ? <span>Collapse sidebar</span> : null}
          </Button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function Navigation({ collapsed, onNavigate }: { collapsed: boolean; onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void }) {
  return <nav aria-label="Learning modes" className="min-h-0 flex-1 space-y-6 overflow-y-auto px-2 py-5">
    {sections.map(section => <NavigationSection key={section.label} {...section} collapsed={collapsed} onNavigate={onNavigate} />)}
  </nav>
}

function NavigationSection({
  collapsed,
  items,
  label,
  onNavigate,
}: {
  collapsed: boolean
  items: ReadonlyArray<{ href: string; label: string; icon: typeof Code2Icon }>
  label: string
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void
}) {
  const pathname = usePathname()
  const [open, setOpen] = useState(true)
  const contentId = useId()
  return (
    <section>
      {!collapsed ? (
        <button
          aria-expanded={open}
          aria-controls={contentId}
          className="mb-2 flex w-full items-center justify-between px-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          {label}
          {open ? <ChevronLeftIcon className="size-3 -rotate-90" /> : <ChevronRightIcon className="size-3" />}
        </button>
      ) : null}
        <div id={contentId} hidden={!open && !collapsed} className="space-y-1">
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
            const Icon = item.icon
            return (
              <Link
                aria-current={active ? 'page' : undefined}
                aria-label={item.label}
                className={cn(
                  'flex h-10 items-center gap-3 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active && 'bg-secondary text-foreground',
                  collapsed && 'justify-center px-0'
                )}
                href={item.href}
                key={item.href}
                onClick={onNavigate}
                title={collapsed ? item.label : undefined}
              >
                <Icon className={cn('size-4 shrink-0', active && 'text-blue-400')} />
                {!collapsed ? item.label : null}
              </Link>
            )
          })}
        </div>
    </section>
  )
}
