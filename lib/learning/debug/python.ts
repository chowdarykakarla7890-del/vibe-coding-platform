import { debugLesson } from '../practice/shared'

const command = { executable: 'python3', args: ['-m', 'unittest', '-v', 'test_lesson.py'] }
const files = (source: string, tests: string) => [
  { path: 'main.py', content: source },
  { path: 'test_lesson.py', content: `import unittest\nfrom main import *\n\nclass LessonTests(unittest.TestCase):\n${tests}\n\nif __name__ == '__main__':\n    unittest.main()\n` },
]
export const pythonDebug = [
  debugLesson({ track: 'python', stage: 'state-bug', title: 'Separate independent note collections',
    summary: 'Notes from an earlier call appear in a new collection. Find the unexpected shared state.',
    concepts: ['debugging', 'default arguments', 'mutability'],
    explanation: 'Python evaluates default argument expressions when a function is defined, not each time it is called. A mutable default can therefore hold data across apparently independent calls. Reproducing the bug requires more than one invocation.',
    instructions: ['Repair add_note(note, notes). When notes is omitted or None, create a new list containing note. Each such call returns an independent collection.', 'When a list is explicitly supplied, append note to that list and return the same list object. Empty notes and duplicate values are allowed; note is a string. Preserve this explicit-list behavior rather than making every call pure.'],
    hints: ['Call add_note twice without the second argument.', 'When is the default [] created?', 'Use a sentinel to distinguish a new collection from an explicitly supplied empty list.'],
    reflectionQuestions: ['Why would a one-call test miss the leak?', 'Why should an explicit empty list not be treated as a missing argument?'],
    examples: [{ input: 'add_note("A"), then add_note("B")', output: '["A"] and ["B"], stored independently' }],
    files: files(`def add_note(note, notes=[]):\n    if notes is None:\n        notes = []\n    notes.append(note)\n    return notes\n`, `    def test_explicit_collection_keeps_identity(self):\n        notes = []\n        self.assertIs(add_note('A', notes), notes)\n        self.assertIs(add_note('A', notes), notes)\n        self.assertEqual(notes, ['A', 'A'])\n\n    def test_independent_default_collections(self):\n        first = add_note('first')\n        second = add_note('second')\n        self.assertEqual(first, ['first'], 'an independent call changed the first collection')\n        self.assertEqual(second, ['second'])\n        self.assertIsNot(first, second)\n\n    def test_none_and_empty_notes(self):\n        self.assertEqual(add_note('', None), [''])\n        self.assertEqual(add_note('next', None), ['next'])`), command,
    quality: 'Removes implicit shared state without changing explicit-list mutation semantics',
  }),
  debugLesson({ track: 'python', stage: 'edge-cases', title: 'Stop counting boundary events twice',
    summary: 'Adjacent usage reports disagree with the full report. Diagnose an interval-boundary error.',
    concepts: ['debugging', 'intervals', 'invariants'],
    explanation: 'Half-open intervals include their start and exclude their end. Adjacent windows then partition time without overlaps: an event at a shared boundary belongs to the later window only. This also gives an empty window zero width.',
    instructions: ['Repair count_events(events, start, end). Events is a list of integer timestamps; start and end are integers with start <= end. Count timestamps in [start,end): include start, exclude end. Each duplicate timestamp is a separate event.', 'Do not reorder or mutate the input. Empty input and start == end return zero. Input validation beyond this domain is not required.'],
    hints: ['Test an event exactly at the boundary between two windows.', 'Compare the sum of adjacent-window counts with one combined count.', 'The same endpoint rule should also handle a zero-width window.'],
    reflectionQuestions: ['Why do half-open windows avoid double counting?', 'What would change if reports intentionally included both endpoints?'],
    examples: [{ input: 'count_events([9,10,10,19,20], 10, 20)', output: '3' }],
    files: files(`def count_events(events, start, end):\n    return sum(1 for timestamp in events if start <= timestamp <= end)\n`, `    def test_nonboundary_events(self):\n        self.assertEqual(count_events([1, 4, 7], 0, 10), 3)\n        self.assertEqual(count_events([], 0, 10), 0)\n\n    def test_exclusive_end_and_duplicate_start(self):\n        self.assertEqual(count_events([9, 10, 10, 19, 20], 10, 20), 3, 'end timestamp was counted')\n        self.assertEqual(count_events([10, 10], 10, 10), 0)\n\n    def test_adjacent_windows_partition_events(self):\n        events = [20, 0, 10, 10, 19, 9]\n        original = events.copy()\n        self.assertEqual(count_events(events, 0, 10) + count_events(events, 10, 20), count_events(events, 0, 20))\n        self.assertEqual(events, original)`), command,
    quality: 'Repairs the endpoint predicate while preserving multiplicity and input order',
  }),
]
