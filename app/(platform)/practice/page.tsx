import { CatalogPage } from '@/components/learning/catalog-page'
import { PRACTICE_ACTIVITIES } from '@/lib/learning/catalog'

export default function PracticePage() {
  return <CatalogPage activities={PRACTICE_ACTIVITIES} mode="practice" />
}
