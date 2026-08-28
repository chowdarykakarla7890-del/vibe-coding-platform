import { ActivityRoute } from '@/components/learning/activity-route'

export default async function PracticeWorkspace({ params }: { params: Promise<{ activityId: string }> }) {
  const { activityId } = await params
  return <ActivityRoute activityId={activityId} mode="practice" />
}
