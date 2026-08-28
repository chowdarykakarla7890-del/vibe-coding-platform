import { ApiError, apiFailure, apiJson, requireOwnedProject, requireUser } from '@/lib/server/api'

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const { projectId } = await params
    await requireOwnedProject(projectId, auth)
    const before = new URL(request.url).searchParams.get('before')
    if (before && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)) || Number(before) < 1)) throw new ApiError(400, 'INVALID_CURSOR', 'Choose a valid conversation cursor.')
    let query = auth.supabase.from('messages').select('id,role,parts,status,model_id,ordinal,updated_at,request_id')
      .eq('user_id', auth.user.id).eq('project_id', projectId).order('ordinal', { ascending: false }).limit(21)
    if (before) query = query.lt('ordinal', Number(before))
    const { data, error } = await query
    if (error) throw error
    const page: typeof data = []
    let bytes = 0
    for (const row of data.slice(0, 20)) {
      const size = Buffer.byteLength(JSON.stringify(row))
      if (page.length && bytes + size > 2 * 1024 * 1024) break
      page.push(row)
      bytes += size
    }
    const nextCursor = data.length > page.length ? page.at(-1)?.ordinal ?? null : null
    return apiJson({ messages: page.reverse(), nextCursor }, requestId)
  } catch (error) { return apiFailure(error, requestId) }
}
