import { CatalogPage } from '@/components/learning/catalog-page'
import { DSA_ACTIVITIES } from '@/lib/learning/catalog'

export default function DsaPage() {
  return <CatalogPage activities={DSA_ACTIVITIES} mode="dsa" />
}
