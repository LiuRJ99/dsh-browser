import { getDomain } from 'tldts'
import type { ApprovalPrompt } from './approval.ts'

/**
 * Normalize an exact origin or a wildcard origin for persistent storage.
 * A literal `*` is an explicit global opt-in; it is never synthesized.
 * Bare domain wildcards are HTTPS aliases; explicit schemes and ports stay scoped.
 */
export function normalizeTrustedOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let trimmed = value.trim()
  if (trimmed === '*') return '*'
  const wildcard = normalizeWildcard(trimmed)
  if (wildcard !== undefined) return wildcard
  if (!/^https?:\/\//i.test(trimmed) && !trimmed.includes('/')) {
    trimmed = `https://${trimmed}`
  }
  try {
    const url = new URL(trimmed)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === '' && url.password === '' && !url.hostname.includes('*')
      ? url.origin
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Normalize a persisted trusted-origin collection without adding implicit
 * global trust. A `*` entry is retained only when it is present in the input;
 * callers loading legacy settings can disable it during migration.
 */
export function normalizeTrustedOrigins(value: unknown, allowGlobal = true): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .map(normalizeTrustedOrigin)
    .filter((entry): entry is string => entry !== undefined && (allowGlobal || entry !== '*')))].sort()
}

/** Whether one concrete web origin is covered by an exact or wildcard entry. */
export function originMatchesTrusted(origin: string, trusted: Iterable<string>): boolean {
  let parsedOrigin: URL | undefined
  try {
    parsedOrigin = new URL(origin)
  } catch {
    return false
  }
  for (const rawEntry of trusted) {
    const entry = canonicalTrustedOrigin(rawEntry)
    if (entry === undefined) continue
    if (entry === '*' || entry === parsedOrigin.origin) return true
    const wildcard = parseWildcard(entry)
    if (wildcard !== undefined) {
      if (parsedOrigin.protocol !== wildcard.protocol || parsedOrigin.port !== wildcard.port) continue
      const host = parsedOrigin.hostname.toLowerCase()
      if (host === wildcard.hostname || host.endsWith(`.${wildcard.hostname}`)) return true
      continue
    }
    try {
      const parsedEntry = new URL(entry)
      if (parsedEntry.protocol !== parsedOrigin.protocol || parsedEntry.port !== parsedOrigin.port) continue
      if (parsedEntry.origin === parsedOrigin.origin) return true
    } catch {}
  }
  return false
}

/**
 * Skip an action prompt only when its full destination boundary is known.
 * A literal `*` in a trusted collection is the sole explicit global opt-in.
 * Cross-origin browser_navigate names both origins; history and invalid URLs
 * deliberately remain untrusted because their destination is not represented.
 */
export function actionCoveredByTrustedOrigins(
  prompt: ApprovalPrompt,
  ...trustedCollections: Iterable<string>[]
): boolean {
  if (prompt.kind !== 'action') return false
  const isGlobalTrusted = trustedCollections.some((c) => {
    if (!c) return false
    for (const t of c) {
      if (t === '*') return true
    }
    return false
  })
  if (isGlobalTrusted) return true
  if (prompt.origins.length === 0) return false
  const hasKnownBoundary = prompt.canTrust
    || (prompt.action === 'browser_navigate' && prompt.origins.length > 1)
  if (!hasKnownBoundary) return false
  return prompt.origins.every((origin) =>
    trustedCollections.some((trusted) => originMatchesTrusted(origin, trusted)))
}

/** Only canonical entries may participate in matching; malformed paths fail closed. */
function canonicalTrustedOrigin(value: unknown): string | undefined {
  const normalized = normalizeTrustedOrigin(value)
  if (normalized === undefined) return undefined
  return value === normalized ? normalized : undefined
}

interface WildcardOrigin {
  protocol: 'http:' | 'https:'
  hostname: string
  port: string
}

function normalizeWildcard(value: string): string | undefined {
  const decodedStar = value.replace(/^((?:https?:\/\/)?)(?:\*|%2a)\./i, '$1*.')
  if (!/^(?:https?:\/\/)?\*\./i.test(decodedStar)) return undefined
  const candidate = /^https?:\/\//i.test(decodedStar) ? decodedStar : `https://${decodedStar}`
  const placeholder = candidate.replace(/^(https?:\/\/)\*\./i, '$1wildcard.')
  try {
    const url = new URL(placeholder)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username !== '' || url.password !== ''
      || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    const hostname = url.hostname.toLowerCase().replace(/^wildcard\./, '')
    if (!isDomainName(hostname)) return undefined
    return `${url.protocol}//*.${hostname}${url.port === '' ? '' : `:${url.port}`}`
  } catch {
    return undefined
  }
}

function parseWildcard(value: string): WildcardOrigin | undefined {
  if (!/^https?:\/\/\*\./i.test(value)) return undefined
  const placeholder = value.replace(/^(https?:\/\/)\*\./i, '$1wildcard.')
  try {
    const url = new URL(placeholder)
    const hostname = url.hostname.toLowerCase().replace(/^wildcard\./, '')
    if (!isDomainName(hostname)) return undefined
    return { protocol: url.protocol as 'http:' | 'https:', hostname, port: url.port }
  } catch {
    return undefined
  }
}

function isDomainName(hostname: string): boolean {
  const labels = hostname.split('.')
  return labels.length >= 2
    && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && getDomain(hostname, { allowPrivateDomains: true }) !== null
}
