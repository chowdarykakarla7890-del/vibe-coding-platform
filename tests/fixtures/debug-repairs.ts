// Test-only focused repairs. Never expose solutions through the catalog.
export const debugRepairs: Record<string, { path: string; from: string; to: string; occurrences?: number }> = {
  'debug-javascript-state-bug': { path: 'src/main.mjs', from: 'next[index].quantity -= units', to: 'next[index] = { ...stock[index], quantity: stock[index].quantity - units }' },
  'debug-javascript-edge-cases': { path: 'src/main.mjs', from: 'start + size - 1', to: 'start + size' },
  'debug-typescript-state-bug': { path: 'src/main.ts', from: "  if (job.status === 'running'", to: "  else if (job.status === 'running'" },
  'debug-typescript-edge-cases': { path: 'src/main.ts', from: 'const value = Number.parseInt(raw.trim(), 10)', to: "if (!/^[0-9]+$/.test(raw.trim())) throw new RangeError('Invalid limit')\n  const value = Number(raw.trim())" },
  'debug-react-state-bug': { path: 'src/App.jsx', from: 'setCount(count + 1)', to: 'setCount(previous => previous + 1)', occurrences: 2 },
  'debug-react-edge-cases': { path: 'src/App.jsx', from: 'key={index}', to: 'key={item.id}' },
  'debug-python-state-bug': { path: 'main.py', from: 'notes=[]', to: 'notes=None' },
  'debug-python-edge-cases': { path: 'main.py', from: 'start <= timestamp <= end', to: 'start <= timestamp < end' },
  'debug-java-state-bug': { path: 'Main.java', from: 'private static final List<String> entries', to: 'private final List<String> entries' },
  'debug-java-edge-cases': { path: 'Main.java', from: 'int sum = 0;', to: 'long sum = 0;' },
  'debug-cpp-state-bug': { path: 'main.hpp', from: '  auto result = tasks;\n  for (std::size_t i=0; i<result.size(); ++i) {\n    if (result[i].done) result.erase(result.begin()+i);\n  }', to: '  std::vector<Task> result;\n  for (const auto& task : tasks) {\n    if (!task.done) result.push_back(task);\n  }' },
  'debug-cpp-edge-cases': { path: 'main.hpp', from: '(sorted[middle-1] + sorted[middle])/2', to: '(static_cast<double>(sorted[middle-1]) + static_cast<double>(sorted[middle]))/2.0' },
}

export function repairDebugSource(activityId: string, source: string) {
  const repair = debugRepairs[activityId]
  if (!repair || source.split(repair.from).length - 1 !== (repair.occurrences ?? 1)) throw new Error(`Debug fixture drift: ${activityId}`)
  return source.replaceAll(repair.from, repair.to)
}
