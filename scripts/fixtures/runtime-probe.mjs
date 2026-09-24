// Loaded only by smoke-runtime.mjs into its isolated real DSH profile.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'

export const name = 'runtime-smoke-probe'
export const inject = ['sessions', 'sessionPersistence', 'sessionQuery', 'sessionProjectionCache']

export async function apply(ctx, config) {
  if (config.reopen) {
    assert.equal(ctx.sessions.get(config.sessionId), undefined, 'session must be cold after restart')
    const observation = await ctx.sessionQuery.observeSession(config.sessionId)
    try {
      assert.equal(observation.source, 'prepared')
      assert.ok(observation.projections)
      await writeFile(config.marker, JSON.stringify({ source: observation.source }))
    } finally {
      observation[Symbol.dispose]()
    }
    return
  }
  const timer = setInterval(() => {
    const session = ctx.sessions.get(config.sessionId)
    if (session === undefined) return
    clearInterval(timer)
    void ctx.sessions.flush(session)
      .then(() => writeFile(config.marker, JSON.stringify({ sessionId: session.id })))
  }, 100)
  ctx.effect(() => () => { clearInterval(timer) })
}
