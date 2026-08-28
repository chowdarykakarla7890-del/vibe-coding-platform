import 'server-only'

const prompt: string = `Read source files from the active Vercel Sandbox before explaining, reviewing, or changing a student's code.

Use this tool whenever the student asks for an explanation of their implementation, requests an assessment, asks why code is failing, or has edited files since the last assistant response. Read only the relevant files. Never claim to have reviewed code you have not read.

For an assessment, inspect the implementation and its tests, then run the most relevant test, lint, type-check, or build command. Base feedback on evidence and cite exact file paths and code details. Do not modify files unless the student explicitly asks for a fix.
`

export default prompt
