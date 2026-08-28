import { CatalogPage } from '@/components/learning/catalog-page'
import { PROJECT_ACTIVITIES } from '@/lib/learning/catalog'

export default function ProjectsPage() {
  return <CatalogPage activities={PROJECT_ACTIVITIES} mode="project" />
}
