import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = new URL('../', import.meta.url)
const require = createRequire(new URL('package.json', root))
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const version = manifest.dependencies['@deepseek-ai/dsh']
const lockfile = readFileSync(new URL('pnpm-lock.yaml', root), 'utf8')
const lockedPackages = [...lockfile.matchAll(/^  '(@deepseek-ai\/dsh(?:-[^@']+)?)@([^(' :]+)[^']*':/gm)]
assert.ok(lockedPackages.length > 0, 'no DSH package keys found in lockfile')
for (const [, name] of lockedPackages) {
  assert.notEqual(name, '@deepseek-ai/dsh-host-apiproxy', 'legacy ApiProxy must not be installed')
}
const criticalNames = new Set(['@deepseek-ai/dsh'])
for (const [, name, resolved] of lockedPackages) {
  if (criticalNames.has(name)) assert.equal(resolved, version, `${name}: lockfile has a different DSH release`)
}

const anchor = require.resolve('@deepseek-ai/dsh/package.json')
const queue = [anchor]
const providers = new Map([['@deepseek-ai/dsh', anchor]])
for (let i = 0; i < queue.length; i++) {
  const parent = queue[i]
  const data = JSON.parse(readFileSync(parent, 'utf8'))
  const resolve = createRequire(parent)
  for (const name of Object.keys({ ...data.dependencies, ...data.peerDependencies })) {
    if (providers.has(name)) continue
    let path
    try { path = resolve.resolve(`${name}/package.json`) } catch (error) {
      if (name.startsWith('@deepseek-ai/dsh') && error.code !== 'MODULE_NOT_FOUND') throw error
      continue
    }
    providers.set(name, path)
    queue.push(path)
  }
}
for (const name of ['dsh-session-query', 'dsh-session-projection-cache']) {
  const path = providers.get(`@deepseek-ai/${name}`)
  assert.ok(path, `${name}: missing runtime provider`)
  const provider = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(typeof provider.version, 'string', `${name}: runtime provider at ${path}`)
  console.log(`${name}@${provider.version}: ${path}`)
}
const cacheName = '@deepseek-ai/dsh-session-projection-cache'
const cacheManifest = providers.get(cacheName)
assert.ok(cacheManifest, `${cacheName}: missing provider manifest`)
let entry
try {
  entry = require.resolve(cacheName)
} catch {
  entry = createRequire(cacheManifest).resolve(cacheName)
}
const { default: Cache } = await import(pathToFileURL(entry).href)
assert.equal(typeof Cache.prototype.hydratePrepared, 'function', `${entry}: hydratePrepared missing`)
console.log('DSH runtime dependency checks passed')
