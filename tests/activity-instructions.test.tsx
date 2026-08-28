// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ActivityInstructions } from '@/components/learning/activity-instructions'
import { PRACTICE_ACTIVITIES } from '@/lib/learning/practice'
import { DEBUG_ACTIVITIES } from '@/lib/learning/debug'
import { getActivity } from '@/lib/learning/catalog'
import { CHALLENGE_ACTIVITIES } from '@/lib/learning/challenges'
import { PROJECT_ACTIVITIES } from '@/lib/learning/blueprints'

afterEach(cleanup)
it.each(PROJECT_ACTIVITIES)('shows all four $id milestones without claiming completion or executing commands', async activity => {
  render(<ActivityInstructions activity={activity} />)
  fireEvent.click(screen.getByRole('button', { name: 'Instructions' }))
  await screen.findByRole('heading', { name: 'Project milestones' })
  expect(screen.getByRole('heading', { name: 'Project checks' })).toBeTruthy()
  for (const milestone of activity.milestones!) {
    expect(screen.getByRole('heading', { name: milestone.title })).toBeTruthy()
    expect(screen.getByText(milestone.goal)).toBeTruthy()
    for (const criterion of milestone.acceptance) expect(screen.getByText(criterion)).toBeTruthy()
    expect(screen.getByText([milestone.check.executable, ...milestone.check.args].join(' '))).toBeTruthy()
  }
  expect(screen.getByText(/learner checklist does not award verified progress/)).toBeTruthy()
  expect(screen.getByText(/Project submissions receive AI-assessed/)).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /run|execute/i })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Instructions' })))
})
it.each(CHALLENGE_ACTIVITIES.filter(x=>x.language==='JavaScript'))('labels the actual $id assessment method', async activity => {
  render(<ActivityInstructions activity={activity}/>)
  fireEvent.click(screen.getByRole('button',{name:'Instructions'}))
  await screen.findByRole('dialog')
  if(activity.framework==='React'){
    expect(screen.getByText(/Challenge submissions receive AI-assessed/)).toBeTruthy()
    expect(screen.queryByText(/Submit runs 24 private/)).toBeNull()
  } else {
    expect(screen.getByText(/Submit runs 24 private server-owned/)).toBeTruthy()
    expect(screen.queryByText(/Challenge submissions receive AI-assessed/)).toBeNull()
  }
})
it('shows regression checks, diagnosis requirements and honest AI assessment for Debug', async () => {
  render(<ActivityInstructions activity={DEBUG_ACTIVITIES[0]}/>)
  fireEvent.click(screen.getByRole('button', { name: 'Instructions' }))
  expect(await screen.findByRole('heading', { name: 'Regression checks' })).toBeTruthy()
  expect(screen.getByText(/Record your reproduction, root cause, repair and regression evidence in DIAGNOSIS.md/)).toBeTruthy()
  expect(screen.getByText(/Debug submissions receive AI-assessed/)).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Practice checks' })).toBeNull()
})
it('opens all instructions, progressive hints and reflection without running anything', async () => {
  const activity=PRACTICE_ACTIVITIES[0]
  render(<ActivityInstructions activity={activity}/>)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'Instructions'}))
  expect(await screen.findByRole('dialog',{name:activity.title})).toBeTruthy()
  for(const instruction of activity.instructions) expect(screen.getByText(instruction)).toBeTruthy()
  expect(screen.getByText(activity.lesson!.explanation)).toBeTruthy()
  const hint=screen.getByText('Hint 1').closest('details')!
  expect(hint.open).toBe(false)
  fireEvent.click(screen.getByText('Hint 1'))
  expect(hint.open).toBe(true)
  for(const question of activity.lesson!.reflectionQuestions) expect(screen.getByText(question)).toBeTruthy()
  expect(screen.getByText(/Practice submissions receive AI-assessed/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'Close'}))
  expect(screen.queryByRole('dialog')).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button',{name:'Instructions'})))
})
it('supports existing manifests without lesson metadata or editable check commands', async () => {
  const activity=getActivity('dsa-python-two-sum')!
  render(<ActivityInstructions activity={activity} language="Java"/>)
  fireEvent.click(screen.getByRole('button',{name:'Instructions'}))
  await screen.findByRole('dialog')
  expect(screen.queryByRole('heading',{name:'Practice checks'})).toBeNull()
  expect(screen.queryByText('Reflect before submitting')).toBeNull()
  expect(screen.queryByText(/Practice submissions receive AI-assessed/)).toBeNull()
})
it('uses the selected variant rather than the default check command', async () => {
  const base=PRACTICE_ACTIVITIES[0]
  const activity = { ...base, variants: { Python: {
    starterFiles: [{ path: 'main.py', content: 'print(1)' }],
    verify: { kind: 'command' as const, command: { executable: 'python3', args: ['checks.py'] } },
  } } }
  render(<ActivityInstructions activity={activity} language="Python"/>)
  fireEvent.click(screen.getByRole('button',{name:'Instructions'}))
  expect(await screen.findByText('python3 checks.py')).toBeTruthy()
  expect(screen.queryByText('node --test lesson.test.mjs')).toBeNull()
})
