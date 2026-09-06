// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  TabAffinityController,
  type AffinityTab,
} from '../src/background/tab-affinity.ts'

function tab(tabId: number, title = `Tab ${tabId}`): AffinityTab {
  return { tabId, windowId: 1, title, url: `https://example.com/${tabId}` }
}

describe('TabAffinityController', () => {
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
