import { javascriptPractice } from './javascript'
import { typescriptPractice } from './typescript'
import { reactPractice } from './react'
import { pythonPractice } from './python'
import { javaPractice, cppPractice } from './compiled'

// Preserve original IDs and ordering so saved routes/progress remain usable.
export const PRACTICE_ACTIVITIES = [
  ...javascriptPractice, ...typescriptPractice, ...reactPractice,
  ...pythonPractice, ...javaPractice, ...cppPractice,
]
