/**
 * Background-level browser tools that never go through the content script:
 *   - `browser_screenshot`  via chrome.debugger (Page.captureScreenshot)
 *   - `browser_download_wait` via chrome.downloads
 *   - `browser_network_capture` via chrome.debugger (Network domain)
 *   - `browser_list_tabs`   via chrome.tabs
 *
 * Each returns a `ToolAnswer` in the same shape the content-script dispatcher
 * produces, so the bridge routing in `background/index.ts` stays uniform.
 *
 * Screenshots and network captures attach chrome.debugger to the controlled
 * tab. chrome.debugger shows a non-blocking "is debugging this browser"
 * infobar (no approval dialog) and is released with detach in a finally.
 *
 * @module
 */

import type { ToolAnswer } from './tools.ts'

/** chrome.debugger is only typed when the "debugger" permission is present. */
type DebuggerApi = typeof chrome.debugger
type Debuggee = { tabId: number }

const MAX_SCREENSHOT_BASE64_CHARS = 50_000_000
const MAX_UPLOAD_FILE_BYTES = 32 * 1024 * 1024
const UPLOAD_FILE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp'])

interface UploadFrame {
  frameId: number
  documentId?: string
}

/** Lazily resolve chrome.debugger so callers without the permission never throw at import. */
function debuggerApi(): DebuggerApi | undefined {
  return (chrome as { debugger?: DebuggerApi }).debugger
}

function unavailable(message: string): ToolAnswer {
  return { ok: false, error: { code: 'content-unavailable', message } }
}

function textAnswer(text: string): ToolAnswer {
  return { ok: true, result: { text } }
}

function uploadBadArgs(message: string): ToolAnswer {
  return { ok: false, error: { code: 'bad-args', message: `browser_upload_file: ${message}` } }
}

function uploadFailed(message: string): ToolAnswer {
  return { ok: false, error: { code: 'action-failed', message: `File upload failed: ${message}` } }
}

function uploadCancelled(): ToolAnswer {
  return { ok: false, error: { code: 'bridge-closed', message: 'The file upload was cancelled.' } }
}

function isUploadCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

interface ValidatedDebuggerUpload {
  index: number
  files: string[]
}

/** Lets the dispatcher reuse its normal content-script injection recovery path. */
export class UploadContentUnavailableError extends Error {
  constructor() {
    super('The file input content script is unavailable in the selected frame.')
    this.name = 'UploadContentUnavailableError'
  }
}

function validateDebuggerUploadArgs(args: Record<string, unknown>): ValidatedDebuggerUpload | ToolAnswer {
  if (typeof args.index !== 'number' || !Number.isInteger(args.index) || args.index < 0) {
    return uploadBadArgs('index must be a non-negative integer.')
  }
  if (!Array.isArray(args.files) || args.files.length === 0) {
    return uploadBadArgs('files must be a non-empty array of absolute paths.')
  }
  const files: string[] = []
  for (let index = 0; index < args.files.length; index += 1) {
    const value = args.files[index]
    if (typeof value !== 'string' || !isAbsoluteLocalPath(value)) {
      return uploadBadArgs(`files[${index}] must be an absolute path.`)
    }
    const dot = value.lastIndexOf('.')
    const extension = dot < 0 ? '' : value.slice(dot).toLowerCase()
    if (!UPLOAD_FILE_EXTENSIONS.has(extension)) {
      return uploadBadArgs(`files[${index}] must use PNG, JPG, JPEG, or WebP.`)
    }
    files.push(value)
  }
  const metadata = Array.isArray(args.fileMetadata) ? args.fileMetadata : []
  for (let index = 0; index < metadata.length; index += 1) {
    const item = metadata[index]
    if (typeof item !== 'object' || item === null) return uploadBadArgs(`fileMetadata[${index}] is invalid.`)
    const size = (item as { size?: unknown }).size
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return uploadBadArgs(`fileMetadata[${index}] has an invalid size.`)
    if (size > MAX_UPLOAD_FILE_BYTES) return uploadBadArgs(`files[${index}] exceeds the 32 MiB per-file limit.`)
  }
  if (args.replace !== undefined && typeof args.replace !== 'boolean') return uploadBadArgs('replace must be a boolean.')
  return { index: args.index, files }
}

function attachToTab(tabId: number): Promise<void> {
  const dbg = debuggerApi()
  if (dbg === undefined) {
    return Promise.reject(new Error('chrome.debugger is unavailable (missing "debugger" permission)'))
  }
  return new Promise((resolve, reject) => {
    const target: Debuggee = { tabId }
    dbg.attach(target, '1.3', () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve()
    })
  })
}

function detachFromTab(tabId: number): void {
  const dbg = debuggerApi()
  if (dbg === undefined) return
  try { void dbg.detach({ tabId }) } catch { /* already detached */ }
}

function sendDebuggerCommand(tabId: number, method: string, params: Record<string, unknown>): Promise<unknown> {
  const dbg = debuggerApi()
  if (dbg === undefined) {
    return Promise.reject(new Error('chrome.debugger is unavailable (missing "debugger" permission)'))
  }
  return new Promise((resolve, reject) => {
    dbg.sendCommand({ tabId } as Debuggee, method, params as Record<string, unknown>, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(result)
    })
  })
}

function uploadNonce(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `dsh-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

function contentTarget(frame: UploadFrame): { frameId: number } | { documentId: string } {
  return frame.documentId === undefined ? { frameId: frame.frameId } : { documentId: frame.documentId }
}

function contentUploadFailure(response: unknown): ToolAnswer | undefined {
  if (typeof response !== 'object' || response === null || (response as { ok?: unknown }).ok !== false) return undefined
  const error = (response as { error?: { code?: unknown; message?: unknown } }).error
  const code = error?.code === 'bad-args' ? 'bad-args' : 'action-failed'
  return {
    ok: false,
    error: { code, message: typeof error?.message === 'string' ? error.message : 'The file input could not be prepared.' },
  }
}

async function clearUploadMarker(tabId: number, frame: UploadFrame, nonce: string): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'DSH_FILE_UPLOAD_CLEANUP',
      nonce,
    }, contentTarget(frame))
  } catch {
    // The frame may have navigated or been removed; its old document no longer
    // exposes a marker that could affect a later upload.
  }
}

/**
 * Resolve a nonce-marked input in any frame. The DOM query handles the common
 * top-document path; the Runtime fallback asks each live execution context for
 * its own node and then converts that object through DOM.requestNode, which is
 * needed when the target is a cross-origin iframe.
 */
async function findMarkedFileInputNode(
  tabId: number,
  rootNodeId: number,
  selector: string,
): Promise<number | undefined> {
  const queryResult = await sendDebuggerCommand(tabId, 'DOM.querySelector', {
    nodeId: rootNodeId,
    selector,
  })
  const directNodeId = (queryResult as { nodeId?: unknown }).nodeId
  if (typeof directNodeId === 'number' && directNodeId > 0) return directNodeId

  const dbg = debuggerApi()
  if (dbg === undefined) return undefined
  const contextIds = new Set<number>()
  const onEvent = (_source: unknown, method: string, params: unknown): void => {
    if (method !== 'Runtime.executionContextCreated') return
    const context = (params as { context?: { id?: unknown } }).context
    if (typeof context?.id === 'number') contextIds.add(context.id)
  }
  dbg.onEvent.addListener(onEvent)
  try {
    await sendDebuggerCommand(tabId, 'Runtime.enable', {})
    const expression = `document.querySelector(${JSON.stringify(selector)})`
    const candidates = contextIds.size === 0 ? [undefined] : [...contextIds]
    for (const contextId of candidates) {
      const result = await sendDebuggerCommand(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: false,
        ...(contextId === undefined ? {} : { contextId }),
      })
      const objectId = (result as { result?: { objectId?: unknown } }).result?.objectId
      if (typeof objectId !== 'string' || objectId === '') continue
      const requested = await sendDebuggerCommand(tabId, 'DOM.requestNode', { objectId })
      const nodeId = (requested as { nodeId?: unknown }).nodeId
      if (typeof nodeId === 'number' && nodeId > 0) return nodeId
    }
    return undefined
  } finally {
    dbg.onEvent.removeListener(onEvent)
  }
}

/**
 * Inject validated local files into one inventoried input. The content script
 * owns the index→element mapping; CDP only sees its one-time nonce marker.
 */
export async function runUploadViaDebugger(
  tabId: number,
  args: Record<string, unknown>,
  frame: UploadFrame,
  signal?: AbortSignal,
): Promise<ToolAnswer> {
  const validated = validateDebuggerUploadArgs(args)
  if ('ok' in validated) return validated
  if (isUploadCancelled(signal)) return uploadCancelled()

  const nonce = uploadNonce()
  const selector = `input[type="file"][data-dsh-upload="${nonce}"]`
  let markerMayExist = true
  let attached = false
  try {
    let prepared: unknown
    try {
      prepared = await chrome.tabs.sendMessage(tabId, {
        type: 'DSH_FILE_UPLOAD_PREPARE',
        args: { index: validated.index },
        nonce,
      }, contentTarget(frame))
    } catch {
      throw new UploadContentUnavailableError()
    }
    const preparationFailure = contentUploadFailure(prepared)
    if (preparationFailure !== undefined) return preparationFailure
    if (typeof prepared !== 'object' || prepared === null
      || (prepared as { ok?: unknown }).ok !== true
      || (prepared as { result?: { uploadToken?: unknown } }).result?.uploadToken !== nonce) {
      return uploadFailed('The content script returned an invalid file-input handle.')
    }
    if (isUploadCancelled(signal)) return uploadCancelled()

    try {
      await attachToTab(tabId)
      attached = true
    } catch {
      return uploadFailed('Chrome could not attach its debugger to the controlled tab.')
    }
    if (isUploadCancelled(signal)) return uploadCancelled()

    await sendDebuggerCommand(tabId, 'DOM.enable', {})
    const documentResult = await sendDebuggerCommand(tabId, 'DOM.getDocument', { depth: -1, pierce: true })
    const rootNodeId = (documentResult as { root?: { nodeId?: unknown } }).root?.nodeId
    if (typeof rootNodeId !== 'number' || rootNodeId <= 0) {
      return uploadFailed('Chrome did not expose the selected document.')
    }
    const nodeId = await findMarkedFileInputNode(tabId, rootNodeId, selector)
    if (nodeId === undefined) {
      return uploadFailed(`The file input [${validated.index}] no longer exists in the selected document.`)
    }
    if (isUploadCancelled(signal)) return uploadCancelled()
    await sendDebuggerCommand(tabId, 'DOM.setFileInputFiles', {
      nodeId,
      files: validated.files,
    })
    if (isUploadCancelled(signal)) return uploadCancelled()
    return textAnswer(`Uploaded ${validated.files.length} file(s) to file input [${validated.index}].`)
  } catch (error: unknown) {
    if (error instanceof UploadContentUnavailableError) throw error
    if (isUploadCancelled(signal)) return uploadCancelled()
    return uploadFailed('Chrome rejected the selected files or the input changed before injection completed.')
  } finally {
    if (markerMayExist) await clearUploadMarker(tabId, frame, nonce)
    if (attached) detachFromTab(tabId)
  }
}

/** Wait for a download initiated on the page to complete and return its path. */
export function runDownloadWait(_tabId: number, args: Record<string, unknown>): Promise<ToolAnswer> {
  const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 30_000
  return new Promise((resolve) => {
    const downloadsApi = (chrome as { downloads?: typeof chrome.downloads }).downloads
    if (downloadsApi === undefined) {
      resolve(unavailable('chrome.downloads is unavailable (missing "downloads" permission)'))
      return
    }
    const timer = setTimeout(() => {
      downloadsApi.onChanged.removeListener(listener)
      resolve({ ok: false, error: { code: 'timeout', message: `No download completed within ${timeoutMs}ms.` } })
    }, timeoutMs)
    const listener = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.state?.current !== 'complete' || delta.id === undefined) return
      void downloadsApi.search({ id: delta.id }).then(([item]) => {
        if (item === undefined) return
        clearTimeout(timer)
        downloadsApi.onChanged.removeListener(listener)
        resolve(textAnswer(`Download completed: ${item.filename} (${item.fileSize} bytes)`))
      })
    }
    downloadsApi.onChanged.addListener(listener)
  })
}

/** Capture matching XHR/fetch responses for a short window and return JSON lines. */
export async function runNetworkCapture(tabId: number, args: Record<string, unknown>): Promise<ToolAnswer> {
  const durationMs = typeof args.durationMs === 'number' && args.durationMs > 0 ? args.durationMs : 3_000
  const urlPattern = typeof args.urlPattern === 'string' && args.urlPattern !== '' ? args.urlPattern : undefined
  const maxResponses = typeof args.maxResponses === 'number' && args.maxResponses > 0 ? Math.floor(args.maxResponses) : 20
  try {
    await attachToTab(tabId)
  } catch (error) {
    return unavailable(`Could not attach debugger to the tab: ${error instanceof Error ? error.message : String(error)}`)
  }
  const dbg = debuggerApi()!
  const captured: Array<{ url: string; status?: number; body?: string }> = []
  const urlByRequestId = new Map<string, string>()
  const events = (_source: unknown, method: string, params: unknown): void => {
    if (method === 'Network.responseReceived') {
      const p = params as { requestId?: string; response?: { url?: string; status?: number } }
      const url = p.response?.url ?? ''
      if (p.requestId !== undefined) urlByRequestId.set(p.requestId, url)
      if (urlPattern !== undefined && !url.includes(urlPattern)) return
      captured.push({ url, status: p.response?.status })
      return
    }
    if (method === 'Network.loadingFinished') {
      const p = params as { requestId?: string }
      if (p.requestId === undefined) return
      const url = urlByRequestId.get(p.requestId)
      const entry = captured.find((c) => c.url === url && c.body === undefined)
      if (entry !== undefined) {
        void sendDebuggerCommand(tabId, 'Network.getResponseBody', { requestId: p.requestId })
          .then((body) => { entry.body = (body as { body?: string }).body })
          .catch(() => {})
      }
    }
  }
  dbg.onEvent.addListener(events)
  try {
    await sendDebuggerCommand(tabId, 'Network.enable', {})
    await new Promise((resolve) => setTimeout(resolve, durationMs))
    const filtered = captured.filter((c) => c.body !== undefined).slice(0, maxResponses)
    if (filtered.length === 0) {
      const total = captured.length
      return textAnswer(total === 0
        ? 'No network responses were captured during the window.'
        : `${total} response(s) observed but none had a readable body${urlPattern !== undefined ? ` matching "${urlPattern}"` : ''}.`)
    }
    const lines = filtered.map((c) => `${c.status ?? '-'} ${c.url}\n${c.body}`).join('\n---\n')
    return textAnswer(lines)
  } finally {
    dbg.onEvent.removeListener(events)
    detachFromTab(tabId)
  }
}

/** List all open tabs with id / title / url. */
export async function runListTabs(): Promise<ToolAnswer> {
  try {
    const tabs = await chrome.tabs.query({})
    const lines = tabs
      .filter((tab) => tab.id !== undefined)
      .map((tab) => `${tab.id} | ${tab.title ?? '(untitled)'} | ${tab.url ?? ''}`)
    return textAnswer(lines.length === 0 ? '(No open tabs.)' : lines.join('\n'))
  } catch (error) {
    return unavailable(`Could not list tabs: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Evaluate a JS expression in the page's main context via chrome.debugger (immune to page CSP). */
export async function runEval(tabId: number, args: Record<string, unknown>): Promise<ToolAnswer> {
  const expression = typeof args.expression === 'string' && args.expression !== '' ? args.expression : ''
  if (expression === '') return { ok: false, error: { code: 'bad-args', message: 'expression must not be empty.' } }
  try {
    await attachToTab(tabId)
  } catch (error) {
    return unavailable(`Could not attach debugger to the tab: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const result = await sendDebuggerCommand(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    const r = result as { result?: { value?: unknown; type?: string; description?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
    if (r.exceptionDetails !== undefined) {
      return unavailable(`Evaluation threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown error'}`)
    }
    const value = r.result?.value
    const rendered = typeof value === 'string'
      ? value
      : value === undefined ? String(r.result?.description ?? 'undefined') : JSON.stringify(value) ?? String(value)
    return textAnswer(rendered)
  } catch (error) {
    return unavailable(`Evaluation failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    detachFromTab(tabId)
  }
}

/** Capture a viewport or full-page screenshot of the controlled tab. */
export async function runScreenshot(tabId: number, args: Record<string, unknown>): Promise<ToolAnswer> {
  const fullPage = args.fullPage === true
  const format = args.format === 'jpeg' ? 'jpeg' : 'png'
  try {
    await attachToTab(tabId)
  } catch (error) {
    return unavailable(`Could not attach debugger to the tab: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    await sendDebuggerCommand(tabId, 'Page.enable', {})
    const result = await sendDebuggerCommand(tabId, 'Page.captureScreenshot', {
      format,
      captureBeyondViewport: fullPage,
      fromSurface: true,
    })
    const data = (result as { data?: unknown }).data
    if (typeof data !== 'string' || data === '') {
      return unavailable('Page.captureScreenshot returned no image data.')
    }
    if (data.length > MAX_SCREENSHOT_BASE64_CHARS) {
      return unavailable(`Screenshot too large (${data.length} base64 chars). Use a viewport screenshot instead of fullPage.`)
    }
    return { ok: true, result: { data } }
  } catch (error) {
    return unavailable(`Screenshot failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    detachFromTab(tabId)
  }
}
