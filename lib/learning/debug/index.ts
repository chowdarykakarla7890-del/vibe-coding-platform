import { javascriptDebug } from './javascript'
import { typescriptDebug } from './typescript'
import { reactDebug } from './react'
import { pythonDebug } from './python'
import { javaDebug, cppDebug } from './compiled'

export const DEBUG_ACTIVITIES = [
  ...javascriptDebug, ...typescriptDebug, ...reactDebug,
  ...pythonDebug, ...javaDebug, ...cppDebug,
]
