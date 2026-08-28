/** Fixed categories and library coordinates only. Never log page messages,
 * authentication URLs, user source, cookies, or provider payloads. */
export function browserDiagnostic(text = '', location = '') {
  const categories = [
    ['hydration', /hydration|didn't match/i],
    ['update-depth', /update depth/i],
    ['diff-model-disposed', /TextModel got disposed before DiffEditorWidget model got reset/],
    ['recursive-decorations', /Invoking deltaDecorations recursively/],
    ['disposed-store', /disposable.*(?:disposed|leaked)/i],
    ['monospace-measurement', /monospace assumptions have been violated/i],
    ['worker-start', /Could not create web worker|Failed to construct 'Worker'/i],
    ['worker-message', /Got reply to unknown seq|Got event for unknown req/],
    ['resize-observer', /ResizeObserver loop/],
    ['canceled', /^(?:Canceled|Cancelled|AbortError|The operation was aborted)\b/i],
    ['duplicate-module', /duplicate.*module|module.*duplicate/i],
    ['editor-contribution', /Editor contribution .* should be eager instantiated/],
    ['touch', /(?:move|end) of an UNKNOWN touch/],
  ]
  const category = categories.find(([, pattern]) => pattern.test(text))?.[0] ?? 'other'
  // Only a packaged library filename is safe; ignore arbitrary document paths
  // and query strings (which may contain one-time authentication credentials).
  const match = `${location}\n${text}`.match(/\/vendor\/monaco\/\d+\.\d+\.\d+\/vs\/(?:[\w-]+\/)*([\w.-]+\.js)(?::(\d+):(\d+))?/)
  const moduleId = text.match(/^Duplicate definition of module '(vs\/[\w./!-]{1,150})'$/)?.[1]
  return { category, ...(moduleId ? { module: moduleId } : {}), ...(match ? { library: match[1], ...(match[2] ? { line: Number(match[2]), column: Number(match[3]) } : {}) } : {}) }
}
