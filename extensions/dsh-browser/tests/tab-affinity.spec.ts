// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  isTabAffinityDecision,
  TabAffinityController,
  type AffinityTab,
} from '../src/background/tab-affinity.ts'

function tab(tabId: number, title = `Tab ${tabId}`): AffinityTab {
  return { tabId, windowId: 1, title, url: `https://example.com/${tabId}` }
}

describe('TabAffinityController', () => {
  it('validates every supported handoff decision at the message boundary', () => {
    expect(isTabAffinityDecision('keep')).toBe(true)
    expect(isTabAffinityDecision('follow')).toBe(true)
    expect(isTabAffinityDecision('keep-always')).toBe(true)
    expect(isTabAffinityDecision('ask-again')).toBe(true)
    expect(isTabAffinityDecision('ignore')).toBe(false)
    expect(isTabAffinityDecision(undefined)).toBe(false)
  })

  it('binds the first tool target and follows metadata updates in place', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    expect(affinity.resolveTarget()).toEqual({ kind: 'initial' })

    expect(affinity.bindInitial(tab(1))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 1 } })

    affinity.observeTab(tab(1, 'Updated title'))
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1, title: 'Updated title' } })
  })

  it('fails closed on a manual switch until the matching handoff is decided', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    const handoff = affinity.snapshot()

    expect(handoff).toMatchObject({ status: 'handoff', controlled: { tabId: 1 }, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })
    expect(affinity.decide('follow', handoff.revision - 1)).toBe(false)
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })

    expect(affinity.decide('follow', handoff.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
  })

  it('keeps operating the bound tab in the background after an explicit keep choice', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    const handoff = affinity.snapshot()

    expect(affinity.decide('keep', handoff.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', controlled: { tabId: 1 }, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })

    affinity.observeActive(tab(3))
    expect(affinity.snapshot().status).toBe('handoff')
  })

  it('stops prompting on later tab switches after keep-always', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))

    const handoff = affinity.snapshot()
    expect(affinity.decide('keep-always', handoff.revision - 1)).toBe(false)
    expect(affinity.decide('keep-always', handoff.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true, controlled: { tabId: 1 } })

    affinity.observeActive(tab(3))
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true, controlled: { tabId: 1 } })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })

    // Returning to the controlled tab and leaving again must still not prompt.
    affinity.observeActive(tab(1))
    expect(affinity.snapshot()).toMatchObject({ status: 'following', pinned: true })
    affinity.observeActive(tab(4))
    expect(affinity.snapshot().status).toBe('background')
  })

  it('drops the keep-always pin whenever the binding changes', () => {
    const followed = new TabAffinityController()
    followed.observeActive(tab(1))
    followed.bindInitial(tab(1))
    followed.observeActive(tab(2))
    followed.decide('keep-always', followed.snapshot().revision)
    followed.observeActive(tab(3))
    expect(followed.decide('follow', followed.snapshot().revision)).toBe(true)
    expect(followed.snapshot()).toMatchObject({ status: 'following', pinned: false, controlled: { tabId: 3 } })
    followed.observeActive(tab(5))
    expect(followed.snapshot().status).toBe('handoff')

    const rebound = new TabAffinityController()
    rebound.observeActive(tab(1))
    rebound.bindInitial(tab(1))
    rebound.observeActive(tab(2))
    rebound.decide('keep-always', rebound.snapshot().revision)
    rebound.rebindActive(tab(2))
    expect(rebound.snapshot()).toMatchObject({ pinned: false, status: 'following' })

    const sessionRebound = new TabAffinityController()
    sessionRebound.bindSession('s1', tab(1))
    sessionRebound.observeActive(tab(2))
    sessionRebound.decide('keep-always', sessionRebound.snapshot().revision)
    sessionRebound.bindSession('s1', tab(3))
    expect(sessionRebound.snapshot()).toMatchObject({ pinned: false, status: 'handoff', controlled: { tabId: 3 } })

    const attached = new TabAffinityController()
    attached.bindSession('s1', tab(1))
    attached.observeActive(tab(2))
    attached.decide('keep-always', attached.snapshot().revision)
    attached.attachSessionTab('s1', tab(3))
    expect(attached.snapshot()).toMatchObject({ pinned: false, status: 'handoff', controlled: { tabId: 3 } })

    const removed = new TabAffinityController()
    removed.bindSession('s1', tab(1))
    removed.observeActive(tab(2))
    removed.decide('keep-always', removed.snapshot().revision)
    removed.removeSession('s1')
    expect(removed.snapshot()).toMatchObject({ pinned: false, status: 'lost', controlled: null })

    const replaced = new TabAffinityController()
    replaced.observeActive(tab(1))
    replaced.bindInitial(tab(1))
    replaced.observeActive(tab(2))
    replaced.decide('keep-always', replaced.snapshot().revision)
    expect(replaced.replaceTab(1, 10)).toBe(true)
    expect(replaced.snapshot()).toMatchObject({ pinned: true, status: 'background', controlled: { tabId: 10 } })
    replaced.observeActive(tab(3))
    expect(replaced.snapshot().status).toBe('background')

    const closed = new TabAffinityController()
    closed.observeActive(tab(1))
    closed.bindInitial(tab(1))
    closed.observeActive(tab(2))
    closed.decide('keep-always', closed.snapshot().revision)
    closed.removeTab(1)
    expect(closed.snapshot()).toMatchObject({ status: 'lost', pinned: false })
  })

  it('re-raises the prompt when the pin is undone, without rebinding', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.decide('keep-always', affinity.snapshot().revision)
    affinity.observeActive(tab(3))

    const pinned = affinity.snapshot()
    expect(affinity.decide('ask-again', pinned.revision - 1)).toBe(false)
    expect(affinity.decide('ask-again', pinned.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'handoff',
      pinned: false,
      controlled: { tabId: 1 },
      active: { tabId: 3 },
    })
    expect(affinity.resolveTarget()).toEqual({ kind: 'handoff' })

    // Undoing a pin that is not set is a no-op rather than a state change.
    expect(affinity.decide('ask-again', affinity.snapshot().revision)).toBe(false)
  })

  it('preserves a pin when focus replays the same session', () => {
    const affinity = new TabAffinityController()
    affinity.bindNewSession('s1', tab(1))
    affinity.bindNewSession('s2', tab(2))
    affinity.focusSession('s1')
    affinity.observeActive(tab(3))
    affinity.decide('keep-always', affinity.snapshot().revision)
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true, controlled: { tabId: 1 } })

    // Session resume replays the focused session: the binding is unchanged, so
    // the pin must survive and no revision is burned.
    const before = affinity.snapshot()
    expect(affinity.focusSession('s1')).toBe(false)
    expect(affinity.snapshot()).toMatchObject({ revision: before.revision, pinned: true, status: 'background' })

    // Moving focus to a session on a different tab drops the pin.
    expect(affinity.focusSession('s2')).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ pinned: false, controlled: { tabId: 2 } })
    expect(affinity.snapshot().revision).toBeGreaterThan(before.revision)
  })

  it('keeps a restored pin when the tab navigated while the worker was down', () => {
    // Restart shape: the stored session snapshot carries old metadata while
    // the live controlled tab has since navigated.
    const affinity = new TabAffinityController()
    affinity.restoreSessionTabs({ s1: tab(1, 'Title at bind time') })
    affinity.restoreControlled(tab(1, 'Title after navigating'))
    affinity.restoreFocusedSession('s1')
    expect(affinity.restorePinned()).toBe(true)
    affinity.observeActive(tab(2))
    expect(affinity.snapshot()).toMatchObject({ status: 'background', pinned: true })

    // Same tab id, different title/url: still the binding the user pinned.
    affinity.focusSession('s1')
    expect(affinity.snapshot()).toMatchObject({ pinned: true, controlled: { tabId: 1 } })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 1 } })
  })

  it('rejects a keep-always pin that has no controlled tab behind it', () => {
    const unbound = new TabAffinityController()
    unbound.observeActive(tab(1))
    expect(unbound.restorePinned()).toBe(false)
    expect(unbound.snapshot().pinned).toBe(false)

    const restored = new TabAffinityController()
    restored.restoreControlled(tab(1))
    expect(restored.restorePinned()).toBe(true)
    restored.observeActive(tab(2))
    expect(restored.snapshot()).toMatchObject({ status: 'background', pinned: true })
    expect(restored.restorePinned()).toBe(false)
  })

  it('supports explicit rebindActive when starting new chat', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.rebindActive(tab(2))).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 }, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toMatchObject({ kind: 'target', tab: { tabId: 2 } })
  })

  it('does not silently rebind after the controlled tab closes', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.removeTab(1)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'lost', controlled: null, active: { tabId: 2 } })
    expect(affinity.resolveTarget()).toEqual({ kind: 'lost' })
    expect(affinity.bindInitial(tab(2))).toBe(false)

    const lost = affinity.snapshot()
    expect(affinity.decide('follow', lost.revision)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { tabId: 2 } })
  })

  it('preserves a following tab when Chrome replaces its identity', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    const before = affinity.snapshot()

    expect(affinity.replaceTab(1, 9)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      revision: before.revision + 1,
      status: 'following',
      controlled: { tabId: 9 },
      active: { tabId: 9 },
    })
    expect(affinity.tracks(1)).toBe(false)
    expect(affinity.allowsTarget(9)).toBe(true)

    affinity.observeTab(tab(9, 'Replacement metadata'))
    expect(affinity.snapshot()).toMatchObject({
      controlled: { tabId: 9, title: 'Replacement metadata' },
      active: { tabId: 9, title: 'Replacement metadata' },
    })
  })

  it('preserves background affinity when either tracked tab is replaced', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.decide('keep', affinity.snapshot().revision)

    expect(affinity.replaceTab(1, 10)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 2 },
    })

    expect(affinity.replaceTab(2, 20)).toBe(true)
    expect(affinity.snapshot()).toMatchObject({
      status: 'background',
      controlled: { tabId: 10 },
      active: { tabId: 20 },
    })
    expect(affinity.allowsTarget(10)).toBe(true)
    expect(affinity.replaceTab(999, 30)).toBe(false)
  })

  it('clears the handoff if the user returns to the controlled tab', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    affinity.bindInitial(tab(1))
    affinity.observeActive(tab(2))
    affinity.observeActive(tab(1, 'Tab 1 again'))

    expect(affinity.snapshot()).toMatchObject({ status: 'following', controlled: { title: 'Tab 1 again' } })
  })

  it('rehydrates controlled and lost states without allowing a fresh automatic bind', () => {
    const restored = new TabAffinityController()
    expect(restored.restoreControlled(tab(4))).toBe(true)
    restored.observeActive(tab(5))
    expect(restored.snapshot()).toMatchObject({ status: 'handoff', controlled: { tabId: 4 }, active: { tabId: 5 } })

    const lost = new TabAffinityController()
    expect(lost.restoreLost()).toBe(true)
    lost.observeActive(tab(5))
    expect(lost.resolveTarget()).toEqual({ kind: 'lost' })
    expect(lost.bindInitial(tab(5))).toBe(false)
  })

  it('keeps dedicated session targets independent from a global pin', () => {
    const affinity = new TabAffinityController()
    affinity.bindNewSession('session-1', tab(1))
    affinity.bindNewSession('session-2', tab(2))
    affinity.focusSession('session-1')
    affinity.observeActive(tab(3))
    expect(affinity.decide('keep-always', affinity.snapshot().revision)).toBe(true)

    expect(affinity.resolveTarget('session-1')).toEqual({ kind: 'target', tab: tab(1) })
    expect(affinity.resolveTarget('session-2')).toEqual({ kind: 'target', tab: tab(2) })
    expect(affinity.allowsTarget(1, 'session-1')).toBe(true)
    expect(affinity.allowsTarget(2, 'session-2')).toBe(true)
    expect(affinity.allowsTarget(3, 'session-2')).toBe(false)
  })

  it('supports independent per-session tab affinity for concurrent sessions', () => {
    const affinity = new TabAffinityController()
    affinity.observeActive(tab(1))
    expect(affinity.bindInitial(tab(1), 'session-1')).toBe(true)

    affinity.observeActive(tab(2))
    expect(affinity.rebindActive(tab(2), 'session-2')).toBe(true)

    expect(affinity.resolveTarget('session-1')).toEqual({ kind: 'target', tab: tab(1) })
    expect(affinity.resolveTarget('session-2')).toEqual({ kind: 'target', tab: tab(2) })

    expect(affinity.allowsTarget(1, 'session-1')).toBe(true)
    expect(affinity.allowsTarget(2, 'session-1')).toBe(false)
    expect(affinity.allowsTarget(2, 'session-2')).toBe(true)
    expect(affinity.allowsTarget(1, 'session-2')).toBe(false)

    expect(affinity.focusSession('session-1')).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ controlled: { tabId: 1 } })
    expect(affinity.focusSession('session-2')).toBe(true)
    expect(affinity.snapshot()).toMatchObject({ controlled: { tabId: 2 } })

    const sessionMap = affinity.sessionMap()
    expect(sessionMap['session-1']).toEqual(tab(1))
    expect(sessionMap['session-2']).toEqual(tab(2))

    const restoredAffinity = new TabAffinityController()
    restoredAffinity.restoreSessionTabs(sessionMap)
    expect(restoredAffinity.resolveTarget('session-1')).toEqual({ kind: 'target', tab: tab(1) })
    expect(restoredAffinity.resolveTarget('session-2')).toEqual({ kind: 'target', tab: tab(2) })
    expect(restoredAffinity.resolveTarget('session-missing')).toEqual({ kind: 'initial' })
    expect(restoredAffinity.allowsTarget(2, 'session-missing')).toBe(false)
  })

  it('binds and removes dedicated session tabs independently without cross-interference', () => {
    const affinity = new TabAffinityController()
    const rev0 = affinity.snapshot().revision

    affinity.bindSession('session-alpha', tab(10, 'Alpha Tab'))
    expect(affinity.snapshot().revision).toBe(rev0 + 1)
    expect(affinity.getSessionTab('session-alpha')).toEqual(tab(10, 'Alpha Tab'))
    expect(affinity.focusedSession()).toBe('session-alpha')
    expect(affinity.snapshot().controlled).toEqual(tab(10, 'Alpha Tab'))

    affinity.bindSession('session-beta', tab(20, 'Beta Tab'))
    expect(affinity.getSessionTab('session-beta')).toEqual(tab(20, 'Beta Tab'))
    // Alpha remains focused until beta is explicitly focused
    expect(affinity.focusedSession()).toBe('session-alpha')
    expect(affinity.snapshot().controlled).toEqual(tab(10, 'Alpha Tab'))

    // An external tab switch does NOT block background session execution
    affinity.observeActive(tab(99, 'User Browsing Tab'))
    expect(affinity.resolveTarget('session-alpha')).toEqual({ kind: 'target', tab: tab(10, 'Alpha Tab') })
    expect(affinity.resolveTarget('session-beta')).toEqual({ kind: 'target', tab: tab(20, 'Beta Tab') })
    expect(affinity.allowsTarget(10, 'session-alpha')).toBe(true)
    expect(affinity.allowsTarget(20, 'session-alpha')).toBe(false)
    expect(affinity.allowsTarget(20, 'session-beta')).toBe(true)
    expect(affinity.allowsTarget(10, 'session-beta')).toBe(false)

    // Focusing beta aligns controlled tab to beta
    affinity.focusSession('session-beta')
    expect(affinity.focusedSession()).toBe('session-beta')
    expect(affinity.snapshot().controlled).toEqual(tab(20, 'Beta Tab'))

    // Removing beta removes its tab mapping and marks state appropriately
    const removed = affinity.removeSession('session-beta')
    expect(removed).toEqual(tab(20, 'Beta Tab'))
    expect(affinity.getSessionTab('session-beta')).toBeUndefined()
    expect(affinity.resolveTarget('session-beta')).toEqual({ kind: 'initial' })
    expect(affinity.allowsTarget(20, 'session-beta')).toBe(false)

    // Alpha is unaffected by beta removal
    expect(affinity.getSessionTab('session-alpha')).toEqual(tab(10, 'Alpha Tab'))
    expect(affinity.allowsTarget(10, 'session-alpha')).toBe(true)
  })
})
