import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// Database-only fixtures: no paid VMs, commands, AI calls, or real user data.
export async function checkCommandReservations({ admin, a, b }) {
  const projectIds = []
  try {
    const projectId = randomUUID()
    projectIds.push(projectId)
    assert.equal((await admin.from('projects').insert({ id: projectId, user_id: a.id, title: 'Temporary command limits', mode: 'playground' })).error, null)
    const sessions = [randomUUID(), randomUUID()]
    assert.equal((await admin.from('sandbox_sessions').insert({
      id: sessions[0], user_id: a.id, project_id: projectId, status: 'stopped', expires_at: new Date(Date.now()+600_000).toISOString(),
    })).error, null)
    const secondProject = randomUUID()
    projectIds.push(secondProject)
    assert.equal((await admin.from('projects').insert({ id: secondProject, user_id: a.id, title: 'Temporary second command scope', mode: 'playground' })).error, null)
    assert.equal((await admin.from('sandbox_sessions').insert({ id: sessions[1], user_id: a.id, project_id: secondProject, status: 'running', expires_at: new Date(Date.now()+600_000).toISOString() })).error, null)
    assert.equal((await admin.from('sandbox_sessions').update({ status: 'running' }).eq('id', sessions[0])).error, null)

    const input = { p_user_id: a.id, p_session_id: sessions[0], p_request_id: randomUUID(), p_executable: 'node', p_origin: 'terminal', p_background: false }
    assert((await a.client.rpc('reserve_command_execution', input)).error, 'Clients cannot reserve their own execution slots directly')
    assert.equal((await admin.rpc('reserve_command_execution', { ...input, p_user_id: b.id })).data.code, 'SANDBOX_NOT_FOUND')
    assert((await admin.rpc('reserve_command_execution', { ...input, p_origin: 'verification', p_background: true })).error)

    const races = await Promise.all(Array.from({ length: 8 }, (_, index) => admin.rpc('reserve_command_execution', { ...input, p_session_id: sessions[index % 2], p_request_id: randomUUID() })))
    assert(races.every((result) => !result.error))
    const accepted = races.flatMap(({ data }) => data.id ? [data.id] : [])
    assert.equal(accepted.length, 3, 'Exactly three reservations across both projects may win')
    assert.equal(races.filter(({ data }) => data.code === 'COMMAND_CONCURRENCY_LIMIT').length, 5)
    assert(races.filter(({ data }) => data.id).every(({ data }) => data.timeout_ms === 60_000))
    assert.equal((await b.client.from('command_audits').select('id').in('id', accepted)).data.length, 0)
    const owned = await a.client.from('command_audits').select('*').in('id', accepted)
    assert.equal(owned.data.length, 3)
    assert(!Object.keys(owned.data[0]).some((key) => ['args','command','output','stdout','stderr'].includes(key)))
    assert((await a.client.from('command_audits').update({ status: 'done', user_id: b.id }).eq('id', accepted[0])).error)
    assert((await a.client.rpc('attach_command_execution', { p_user_id: a.id, p_reservation_id: accepted[0], p_command_id: 'fake' })).error)
    assert((await a.client.rpc('attach_encoded_command', { p_user_id: a.id, p_reservation_id: accepted[0], p_command_id: 'fake' })).error)
    assert.equal((await admin.rpc('attach_encoded_command', { p_user_id: b.id, p_reservation_id: accepted[0], p_command_id: 'fake' })).data, false)
    assert(owned.data.every(row => row.output_encoding === 'raw'), 'Existing/unattached commands default to raw output')
    assert((await a.client.from('command_audits').update({ output_encoding: 'base64-v1' }).eq('id', accepted[0])).error)
    assert.equal((await admin.rpc('attach_command_execution', { p_user_id: b.id, p_reservation_id: accepted[0], p_command_id: 'fake' })).data, false)
    assert.equal((await admin.rpc('finish_command_execution', { p_user_id: b.id, p_reservation_id: accepted[0], p_status: 'done', p_exit_code: 0 })).data, false)
    assert((await a.client.rpc('finish_command_execution', { p_user_id: a.id, p_reservation_id: accepted[0], p_status: 'done', p_exit_code: 0 })).error)

    assert.equal((await admin.rpc('finish_command_execution', { p_user_id: a.id, p_reservation_id: accepted[0], p_status: 'unknown' })).data, true)
    assert.equal((await admin.rpc('reserve_command_execution', input)).data.code, 'COMMAND_CONCURRENCY_LIMIT', 'Unknown launch retains its slot')
    for (const id of accepted) assert.equal((await admin.rpc('finish_command_execution', { p_user_id: a.id, p_reservation_id: id, p_status: 'done', p_exit_code: 0 })).data, true)
    const priorRequest = owned.data[0].request_id
    assert.equal((await admin.rpc('reserve_command_execution', { ...input, p_request_id: priorRequest })).data.code, 'COMMAND_ALREADY_RESERVED')
    assert.equal((await admin.rpc('finish_command_execution', { p_user_id: a.id, p_reservation_id: accepted[0], p_status: 'unknown' })).data, false, 'Late failure must not overwrite completion')

    for (let count = 3; count < 30; count++) {
      const next = await admin.rpc('reserve_command_execution', { ...input, p_request_id: randomUUID() })
      assert(next.data.id && !next.error)
      const attachName = count % 2 ? 'attach_encoded_command' : 'attach_command_execution'
      assert.equal((await admin.rpc(attachName, { p_user_id: a.id, p_reservation_id: next.data.id, p_command_id: `fixture-${count}` })).data, true)
      const encoded = await a.client.from('command_audits').select('command_id,output_encoding').eq('id', next.data.id).single()
      assert.equal(encoded.data.output_encoding, count % 2 ? 'base64-v1' : 'raw')
      assert.equal((await admin.rpc('attach_encoded_command', { p_user_id: a.id, p_reservation_id: next.data.id, p_command_id: `replacement-${count}` })).data, false, 'An attached format/command cannot be replaced')
      assert.equal((await admin.rpc('finish_command_execution', { p_user_id: a.id, p_reservation_id: next.data.id, p_status: 'done', p_exit_code: 0 })).data, true)
    }
    assert.equal((await admin.rpc('reserve_command_execution', input)).data.code, 'COMMAND_RATE_LIMIT')
    // Age only this fixture's metadata to verify the rolling window resets.
    assert.equal((await admin.from('command_audits').update({ created_at: new Date(Date.now()-61_000).toISOString() }).eq('user_id', a.id).in('sandbox_session_id', sessions)).error, null)
    const background = await admin.rpc('reserve_command_execution', { ...input, p_background: true })
    assert(background.data.id && background.data.timeout_ms > 60_000 && background.data.timeout_ms <= 600_000)
    assert.equal((await admin.from('sandbox_sessions').update({ status: 'stopped' }).in('id', sessions)).error, null)
    assert.equal((await admin.rpc('reserve_command_execution', { ...input, p_request_id: randomUUID() })).data.code, 'SANDBOX_EXPIRED')
    console.log('PASS: atomic 3-command cross-project cap, rolling 30/minute limit, unknown-launch safety, private RPCs, audit RLS/immutability, timeouts, and stale-completion fencing.')
  } finally {
    if (projectIds.length) {
      assert.equal((await admin.from('projects').delete().in('id', projectIds).eq('user_id', a.id)).error, null)
      assert.equal((await admin.from('command_audits').select('id').eq('user_id', a.id)).data.length, 0, 'Fixture project deletion cascades command audit records')
    }
  }
}
