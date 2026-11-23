const STORAGE_KEY = 'dshSessionTabGroups'
const TITLES_KEY = 'dshSessionTabGroupTitles'

/** Host lookups a cold cache can fall back to. */
export interface SessionTabGroupsDeps {
  /** Resolve one session's durable title from the Host. */
  resolveTitle?: (sessionId: string) => Promise<string | undefined>
  /** Recover the group that already holds this session's tab, e.g. after a worker restart. */
  resolveGroup?: (sessionId: string) => Promise<number | undefined>
}

/** Keep tabs created by a main agent and its subagents together across worker restarts. */
export class SessionTabGroups {
  readonly available = typeof chrome.tabs.group === 'function'
    && typeof chrome.tabGroups?.get === 'function'
    && typeof chrome.tabGroups?.update === 'function'
  private readonly ids = new Map<string, number>()
  private readonly titles = new Map<string, string>()
  private readonly ready: Promise<void> = Promise.all([this.restoreGroups(), this.restoreTitles()])
    .then(() => undefined)
  private creating = this.ready

  constructor(private readonly deps: SessionTabGroupsDeps = {}) {}

  async get(sessionId?: string): Promise<chrome.tabGroups.TabGroup | undefined> {
    const sid = sessionId?.trim()
    if (!this.available || !sid) return undefined
    await this.ready
    const id = this.ids.get(sid)
    if (id === undefined) return undefined
    try {
      return await chrome.tabGroups.get(id)
    } catch {
      // Chrome removes a group as soon as its last tab is closed or ungrouped.
      return undefined
    }
  }

  async containsTab(tabId: number): Promise<boolean> {
    if (!this.available) return false
    await this.ready
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    return tab !== undefined && Array.from(this.ids.values()).includes(tab.groupId)
  }

  /**
   * Record one session title and rename that session's group when it already exists.
   * Titles arrive from the live `session/title` event and from the panel's history replay,
   * so a group created before its title existed is corrected as soon as the title shows up.
   */
  async rememberTitle(sessionId: string | undefined, title: string | undefined): Promise<void> {
    const sid = sessionId?.trim()
    const normalized = normalizeTitle(title)
    if (!this.available || !sid || normalized === undefined) return
    await this.ready
    if (this.titles.get(sid) === normalized) return
    this.titles.set(sid, normalized)
    const id = this.ids.get(sid)
    await Promise.allSettled([
      id === undefined ? Promise.resolve() : chrome.tabGroups.update(id, { title: formatGroupTitle(normalized, sid) }),
      persistTitles(this.titles),
    ])
  }

  /** Prefer the cached title; ask the Host once and remember the answer when the cache is cold. */
  private async groupTitle(sessionId: string): Promise<string | undefined> {
    const cached = this.titles.get(sessionId)
    if (cached !== undefined) return cached
    const resolve = this.deps.resolveTitle
    if (resolve === undefined) return undefined
    const resolved = normalizeTitle(await resolve(sessionId))
    const current = this.titles.get(sessionId)
    if (current !== undefined) return current
    if (resolved === undefined) return undefined
    this.titles.set(sessionId, resolved)
    void persistTitles(this.titles).catch(() => {})
    return resolved
  }

  /** Recover a group after Chrome reloads the extension and clears session storage. */
  private async adoptGroup(sessionId: string): Promise<chrome.tabGroups.TabGroup | undefined> {
    const id = await this.deps.resolveGroup?.(sessionId).catch(() => undefined)
    const bound = id === undefined ? undefined : await chrome.tabGroups.get(id).catch(() => undefined)
    const fallbackTitle = formatGroupTitle(undefined, sessionId)
    const title = this.titles.get(sessionId)
    // The session may have explicitly attached to a tab in the user's group.
    let group = bound?.title === fallbackTitle || (title !== undefined && bound?.title === title)
      ? bound : undefined
    if (group === undefined && typeof chrome.tabGroups.query === 'function') {
      const matches = await chrome.tabGroups.query({ title: fallbackTitle }).catch(() => [])
      const exact = matches.filter((candidate) => candidate.title === fallbackTitle)
      if (exact.length === 1) group = exact[0]
    }
    if (group === undefined) return undefined
    this.ids.set(sessionId, group.id)
    void chrome.storage.session.set({ [STORAGE_KEY]: Object.fromEntries(this.ids) }).catch(() => {})
    return group
  }

  /**
   * Rename one group once its session title is known. Group creation never waits
   * for the Host: a cold cache renders the fallback name and this corrects it.
   */
  private refreshTitle(sessionId: string, groupId: number): void {
    void this.groupTitle(sessionId).then(async (title) => {
      if (title === undefined) return
      const group = await chrome.tabGroups.get(groupId).catch(() => undefined)
      if (group?.title !== formatGroupTitle(undefined, sessionId)) return
      const name = formatGroupTitle(this.titles.get(sessionId) ?? title, sessionId)
      await chrome.tabGroups.update(groupId, { title: name })
    }).catch(() => {})
  }

  createTab(sessionId: string | undefined, properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
    const sid = sessionId?.trim()
    if (!this.available || !sid) return chrome.tabs.create(properties)
    // Serialize placement so concurrent first opens share one group and storage write order.
    const pending = this.creating.then(() => this.createGroupedTab(sid, { ...properties, active: properties.active ?? false }))
    this.creating = pending.then(() => {}, () => {})
    return pending
  }

  private async createGroupedTab(sessionId: string, properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
    const group = await this.get(sessionId) ?? await this.adoptGroup(sessionId)
    const tab = await chrome.tabs.create(group === undefined ? properties : { ...properties, windowId: group.windowId })
    if (tab.id === undefined) return tab
    try {
      if (group === undefined) {
        const id = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } })
        this.ids.set(sessionId, id)
        await Promise.allSettled([
          chrome.tabGroups.update(id, {
            title: formatGroupTitle(this.titles.get(sessionId), sessionId),
            ...(!tab.active ? { collapsed: true } : {}),
          }),
          chrome.storage.session.set({ [STORAGE_KEY]: Object.fromEntries(this.ids) }),
        ])
        if (!this.titles.has(sessionId)) this.refreshTitle(sessionId, id)
      } else {
        await chrome.tabs.group({ groupId: group.id, tabIds: tab.id })
        if (group.title === formatGroupTitle(undefined, sessionId)) this.refreshTitle(sessionId, group.id)
      }
      return await chrome.tabs.get(tab.id)
    } catch {
      // Keep the dedicated tab usable if the group was removed or the window cannot group tabs.
      return tab
    }
  }

  private async restoreGroups(): Promise<void> {
    if (!this.available) return
    try {
      const stored: unknown = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY]
      if (typeof stored !== 'object' || stored === null) return
      for (const [sessionId, id] of Object.entries(stored)) {
        if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) this.ids.set(sessionId, id)
      }
    } catch {
      // Session storage is optional for keeping groups together within one worker lifetime.
    }
  }

  private async restoreTitles(): Promise<void> {
    if (!this.available) return
    try {
      const stored: unknown = (await chrome.storage.session.get(TITLES_KEY))[TITLES_KEY]
      if (typeof stored !== 'object' || stored === null) return
      for (const [sessionId, title] of Object.entries(stored)) {
        const normalized = normalizeTitle(typeof title === 'string' ? title : undefined)
        if (normalized !== undefined) this.titles.set(sessionId, normalized)
      }
    } catch {
      // Titles are a cosmetic enrichment; the short session id remains the fallback name.
    }
  }
}

/** Prefer the session's own title, falling back to the short session id. */
export function formatGroupTitle(title: string | undefined, sessionId: string): string {
  const normalized = normalizeTitle(title)
  if (normalized !== undefined) return normalized
  const label = sessionId.replace(/^session-/, '') || sessionId
  return `DSH · ${label.length > 16 ? label.slice(-8) : label}`
}

function normalizeTitle(title: string | undefined): string | undefined {
  if (typeof title !== 'string') return undefined
  const collapsed = title.replace(/\s+/gu, ' ').trim()
  return collapsed === '' ? undefined : collapsed
}

function persistTitles(titles: ReadonlyMap<string, string>): Promise<void> {
  return chrome.storage.session.set({ [TITLES_KEY]: Object.fromEntries(titles) })
}
