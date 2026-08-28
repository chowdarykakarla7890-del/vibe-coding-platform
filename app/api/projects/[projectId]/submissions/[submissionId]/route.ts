import { z } from 'zod'
import { ApiError, apiFailure, apiJson, requireOwnedProject, requireUser } from '@/lib/server/api'
import { consumeQuota } from '@/lib/server/rate-limit'
import { sourceFileSchema } from '@/lib/learning/types'
import { visibleSubmissionState } from '@/lib/learning/submissions'
import { readGradingSummary } from '@/lib/server/grading-evidence'

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string; submissionId: string }> }) {
  const requestId = crypto.randomUUID()
  try {
    const auth = await requireUser(request)
    const { projectId, submissionId } = await params
    if (!z.string().uuid().safeParse(submissionId).success) throw new ApiError(400, 'INVALID_SUBMISSION_ID', 'Choose a valid submission.')
    await requireOwnedProject(projectId, auth)
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
    const quota = await consumeQuota(auth.user.id, 'source-read')
    const { data: submission, error } = await auth.supabase.from('activity_submissions').select('*')
      .eq('id', submissionId).eq('project_id', projectId).eq('user_id', auth.user.id).abortSignal(signal).maybeSingle()
    if (error) throw error
    if (!submission) throw new ApiError(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.')
    const versions = z.array(z.object({ path: z.string(), revision: z.number().int().positive() })).max(200).parse(submission.source_versions)
    const file = new URL(request.url).searchParams.get('file')
    if (file !== null) {
      if (!/^(0|[1-9][0-9]{0,2})$/.test(file) || Number(file) >= versions.length) throw new ApiError(400, 'INVALID_SUBMITTED_FILE', 'Choose a file from this submission.')
      // Database JSON projection bounds each response to one 256 KB source file,
      // rather than returning a whole 10 MB snapshot through a function response.
      const source = await auth.supabase.from('submission_sources').select(`file:files->${Number(file)}`)
        .eq('id', submission.source_id).eq('project_id', projectId).eq('user_id', auth.user.id).abortSignal(signal).single()
      if (source.error) throw source.error
      const parsed = z.object({ file: sourceFileSchema }).parse(source.data).file
      const version = versions[Number(file)]
      if (parsed.path !== version.path) throw new ApiError(502, 'SUBMISSION_SOURCE_INVALID', 'The submitted file could not be verified.')
      return apiJson({ ...parsed, revision: version.revision }, requestId, 200, quota)
    }
    const [source, assessment, gradingSummary] = await Promise.all([
      auth.supabase.from('submission_sources').select('digest').eq('id', submission.source_id).eq('project_id', projectId).eq('user_id', auth.user.id).abortSignal(signal).single(),
      auth.supabase.from('assessments').select('score,passed,feedback,source_current,ai_assessed').eq('submission_id', submissionId).eq('project_id', projectId).eq('user_id', auth.user.id).abortSignal(signal).maybeSingle(),
      readGradingSummary(auth, projectId, submissionId, signal),
    ])
    if (source.error || assessment.error) throw source.error ?? assessment.error
    return apiJson({ id: submission.id, createdAt: submission.created_at, language: submission.language, modelId: submission.model_id,
      state: visibleSubmissionState(submission.state as 'pending' | 'complete' | 'failed', submission.expires_at), failureCode: submission.failure_code,
      score: assessment.data?.score ?? null, passed: assessment.data?.passed ?? null, sourceCurrentAtAssessment: assessment.data?.source_current ?? null,
      aiAssessed: assessment.data?.ai_assessed ?? null,
      feedback: assessment.data?.feedback ?? [], sourceDigest: source.data.digest, files: versions, gradingSummary,
      title: z.object({ title: z.string() }).parse(submission.manifest).title,
    }, requestId, 200, quota)
  } catch (error) { return apiFailure(error, requestId) }
}
