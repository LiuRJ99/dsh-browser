import { getDomain } from 'tldts'
import type { ApprovalPrompt } from './approval.ts'

/**
 * Normalize an exact origin or a wildcard origin for persistent storage.
 * Bare wildcards are HTTPS aliases; explicit schemes and ports stay scoped.
 */
export function normalizeTrustedOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let trimmed = value.trim()
  if (trimmed === '*' || trimmed === '<all_urls>') return '*'
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

/** Whether one concrete web origin is covered by an exact or wildcard entry. */
export function originMatchesTrusted(origin: string, trusted: Iterable<string>): boolean {
  let parsedOrigin: URL | undefined
  try {
    parsedOrigin = new URL(origin)
  } catch {
    return false
  }
  for (const entry of trusted) {
    if (entry === '*' || entry === '<all_urls>' || entry === origin) return true
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
      const h1 = parsedOrigin.hostname.toLowerCase()
      const h2 = parsedEntry.hostname.toLowerCase()
      if (h1 === h2 || h1.endsWith(`.${h2}`)) return true
    } catch {}
  }
  return false
}

/**
 * Skip an action prompt only when its full destination boundary is known.
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
      if (t === '*' || t === '<all_urls>') return true
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
