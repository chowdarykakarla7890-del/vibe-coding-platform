import { CatalogPage } from '@/components/learning/catalog-page'
import { CHALLENGE_ACTIVITIES } from '@/lib/learning/catalog'

export default function ChallengesPage() {
  return <CatalogPage activities={CHALLENGE_ACTIVITIES} mode="challenge" />
}
