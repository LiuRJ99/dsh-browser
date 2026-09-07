import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
assert.equal(typeof packageJson.dependencies['@deepseek-ai/dsh'], 'string')

const bridge = await import(new URL('packages/browser/bridge-browser/lib/index.js', root).href)
assert.equal(bridge.name, 'bridge-browser')
assert.equal(typeof bridge.apply, 'function')

const extensionManifest = JSON.parse(await readFile(new URL('extensions/dsh-browser/dist/manifest.json', root), 'utf8'))
assert.ok(Array.isArray(extensionManifest.permissions))
assert.ok(extensionManifest.permissions.includes('debugger'), 'debugger permission missing from built extension')
assert.ok(extensionManifest.permissions.includes('downloads'), 'downloads permission missing from built extension')

console.log('dsh-browser runtime smoke passed: bridge artifact and extension permissions are loadable')
