// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalDialog } from '../src/panel/App.tsx'
import { PANEL_COPY } from '../src/panel/strings.ts'
import type { ApprovalDecision, ApprovalRequest } from '../src/security/approval.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root !== undefined) {
    act(() => { root?.unmount() })
    root = undefined
  }
  container?.remove()
  container = undefined
})

async function renderApproval(request: ApprovalRequest): Promise<ReturnType<typeof vi.fn>> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const onDecision = vi.fn<(decision: ApprovalDecision) => void>()
  await act(async () => {
    root?.render(createElement(ApprovalDialog, { request, onDecision, copy: PANEL_COPY.zh }))
  })
  return onDecision
}

const ACTION: ApprovalRequest = {
  id: 'approval-1',
  kind: 'action',
  action: 'browser_click',
  summary: '点击元素 [3]',
  origins: ['https://example.com'],
  canTrust: true,
}

describe('ApprovalDialog trusted-origin actions', () => {
  it('offers adding a stable origin to the trusted list', async () => {
    const onDecision = await renderApproval(ACTION)
    const button = container?.querySelector<HTMLButtonElement>('button.origin-trust')

    expect(button?.textContent).toBe('加入信任名单')
    expect(container?.querySelector('button.session-trust')).not.toBeNull()
    await act(async () => { button?.click() })
    expect(onDecision).toHaveBeenCalledWith('trust-origin')
  })

  it('uses the same origin trust controls for JavaScript execution', async () => {
    const onDecision = await renderApproval({
      ...ACTION,
      action: 'browser_eval',
      summary: '在页面中执行 JavaScript',
    })
    const button = container?.querySelector<HTMLButtonElement>('button.session-trust')

    expect(button?.textContent).toBe('本次会话信任此域')
    expect(container?.querySelector('button.advanced-trust')).toBeNull()
    await act(async () => { button?.click() })
    expect(onDecision).toHaveBeenCalledWith('trust-session')
  })

  it('uses the same session trust decision for unknown-destination history navigation', async () => {
    const onDecision = await renderApproval({
      ...ACTION,
      action: 'browser_back',
      canTrust: false,
      advancedPermission: 'history',
    })
    const button = container?.querySelector<HTMLButtonElement>('button.session-trust')

    expect(button?.textContent).toBe('本次会话允许历史导航')
    expect(container?.querySelector('button.origin-trust')).toBeNull()
    await act(async () => { button?.click() })
    expect(onDecision).toHaveBeenCalledWith('trust-session')
  })

  it('does not offer origin trust for reads or uncertain boundaries', async () => {
    await renderApproval({ ...ACTION, kind: 'read', canTrust: false })
    expect(container?.querySelector('button.origin-trust')).toBeNull()

    await act(async () => {
      root?.render(createElement(ApprovalDialog, {
        request: {
          ...ACTION,
          origins: ['https://example.com', 'https://bank.example'],
          canTrust: false,
        },
        onDecision: vi.fn(),
        copy: PANEL_COPY.zh,
      }))
    })
    expect(container?.querySelector('button.origin-trust')).toBeNull()
  })
})
