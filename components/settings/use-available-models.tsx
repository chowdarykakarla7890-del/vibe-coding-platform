import useSWR from 'swr'

export interface DisplayModel {
  id: string
  label: string
  tier: 'primary' | 'affordable'
}

async function fetchModels(path: string): Promise<DisplayModel[]> {
  const response = await fetch(path)
  if (!response.ok) throw new Error('Failed to fetch models')
  const data = await response.json()
  if (!Array.isArray(data.models)) throw new Error('Invalid model response')
  return data.models.map((model: { id: string; name: string; tier: DisplayModel['tier'] }) => ({ id: model.id, label: model.name, tier: model.tier }))
}

export function useAvailableModels() {
  const { data, error, isLoading } = useSWR('/api/models', fetchModels, {
    errorRetryCount: 3,
    errorRetryInterval: 5000,
    revalidateOnFocus: false,
  })
  return { models: data ?? [], isLoading, error: error instanceof Error ? error : null }
}
