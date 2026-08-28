import { CatalogPage } from '@/components/learning/catalog-page'
import { DEBUG_ACTIVITIES } from '@/lib/learning/catalog'

export default function DebugPage() {
  return <CatalogPage activities={DEBUG_ACTIVITIES} mode="debug" />
}
