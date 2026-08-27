/** Pure authorization policy for model-requested browser tools. */

import type { ToolCall } from './tools.ts'
import type { TabFrame } from './frames.ts'
import type { ApprovalPrompt } from '../security/approval.ts'
import { getUiLocale, type UiLocale } from '../i18n.ts'

const PAGE_READS = new Set([
  'browser_snapshot',
  'browser_get_text',
  'browser_screenshot',
  'browser_get_table',
  'browser_list_tabs',
  'browser_network_capture',
])
/** File uploads have a dedicated summary, but stable origins may still be trusted. */
export const FILE_UPLOAD_ACTIONS = new Set(['browser_upload_file'])
const STATE_CHANGING_ACTIONS = new Set([
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_click_text',
  'browser_eval',
])

/** Return an approval prompt, or undefined when this call needs no prompt. */
export function approvalPromptForCall(
  call: ToolCall,
  sharePageContent: 'ask' | 'auto' | 'off',
  frames: TabFrame[],
  locale: UiLocale = getUiLocale(),
): ApprovalPrompt | undefined {
  if (PAGE_READS.has(call.name)) {
    if (sharePageContent !== 'ask') return undefined
    const targetFrames = call.name === 'browser_snapshot'
      ? frames
      : frames.filter((frame) => frame.frameId === requestedFrame(call.args))
    return {
      kind: 'read',
      action: call.name,
      summary: readSummary(call, locale),
      origins: uniqueOrigins(targetFrames, frames),
      canTrust: false,
    }
  }

  if (FILE_UPLOAD_ACTIONS.has(call.name)) {
    const frameId = requestedFrame(call.args)
    const target = frames.find((frame) => frame.frameId === frameId) ?? frames.find((frame) => frame.frameId === 0)
    const origins = uniqueOrigins(target === undefined ? [] : [target], frames)
    return {
      kind: 'action',
      action: call.name,
      summary: summarizeFileUpload(call, locale),
      origins,
      // Uploads still require a known, single destination origin before they
      // can inherit either session or permanent origin trust.
      canTrust: origins.length === 1,
    }
  }

  if (!STATE_CHANGING_ACTIONS.has(call.name)) return undefined
  const frameId = requestedFrame(call.args)
  const target = frames.find((frame) => frame.frameId === frameId) ?? frames.find((frame) => frame.frameId === 0)
  const origins = uniqueOrigins(target === undefined ? [] : [target], frames)
  let canTrust = origins.length === 1 && call.name !== 'browser_back' && call.name !== 'browser_forward'
  if (call.name === 'browser_navigate') {
    const destination = originFromUrl(typeof call.args.url === 'string' ? call.args.url : '')
    if (destination !== undefined && !origins.includes(destination)) origins.push(destination)
    // Do not let an invalid, opaque, or cross-origin navigation become a
    // back door for adding the current page to the persistent allowlist.
    canTrust = destination !== undefined && origins.length === 1 && origins[0] === destination
  }
  return {
    kind: 'action',
    action: call.name,
    summary: summarizeAction(call, locale),
    origins,
    // Cross-origin/invalid navigation and unknown history destinations always
    // require a fresh decision; they must never expand trust implicitly.
    canTrust,
  }
}

function requestedFrame(args: Record<string, unknown>): number {
  return typeof args.frame === 'number' && Number.isInteger(args.frame) && args.frame >= 0 ? args.frame : 0
}

function uniqueOrigins(targets: TabFrame[], allFrames: TabFrame[]): string[] {
  const origins = new Set<string>()
  for (const frame of targets) {
    const origin = effectiveFrameOrigin(frame, allFrames)
    if (origin !== undefined) origins.add(origin)
  }
  return [...origins].sort()
}

function effectiveFrameOrigin(frame: TabFrame, frames: TabFrame[], visited = new Set<number>()): string | undefined {
  if (visited.has(frame.frameId)) return undefined
  visited.add(frame.frameId)
  const direct = originFromUrl(frame.url)
  if (direct !== undefined) return direct
  const parent = frames.find((candidate) => candidate.frameId === frame.parentFrameId)
  return parent === undefined ? undefined : effectiveFrameOrigin(parent, frames, visited)
}

export function originFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'blob:') return undefined
    return url.origin === 'null' ? undefined : url.origin
  } catch {
    return undefined
  }
}

function summarizeAction(call: ToolCall, locale: UiLocale): string {
  const frame = typeof call.args.frame === 'number' && call.args.frame !== 0
    ? localized(locale, `, iframe ${call.args.frame}`, `，iframe ${call.args.frame}`)
    : ''
  const index = typeof call.args.index === 'number' ? call.args.index : '?'
  switch (call.name) {
    case 'browser_click': return localized(locale, `Click element [${index}]${frame}`, `点击元素 [${index}]${frame}`)
    case 'browser_click_text': return localized(
      locale,
      `Click element by text/selector${frame}`,
      `按文本/选择器点击元素${frame}`,
    )
    case 'browser_eval': return localized(locale, 'Run JavaScript in the page', '在页面中执行 JavaScript')
    case 'browser_type': {
      const length = typeof call.args.text === 'string' ? call.args.text.length : 0
      return localized(
        locale,
        `Enter ${length} characters in element [${index}]${frame} (the text is not shown in this dialog)`,
        `向元素 [${index}] 输入 ${length} 个字符${frame}（文本内容不会显示在确认框）`,
      )
    }
    case 'browser_press': return localized(
      locale,
      `Press “${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}”${frame}`,
      `发送按键「${safeInline(typeof call.args.key === 'string' ? call.args.key : '')}」${frame}`,
    )
    case 'browser_navigate': return localized(
      locale,
      `Navigate to ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
      `导航到 ${displayUrl(typeof call.args.url === 'string' ? call.args.url : '', locale)}`,
    )
    case 'browser_back': return localized(locale, 'Go back in browser history (destination domain unknown)', '返回浏览历史上一页（目标域名未知）')
    case 'browser_forward': return localized(locale, 'Go forward in browser history (destination domain unknown)', '前进到浏览历史下一页（目标域名未知）')
    case 'browser_reload': return localized(locale, 'Reload the current page', '重新加载当前页面')
    default: return call.name
  }
}

function summarizeFileUpload(call: ToolCall, locale: UiLocale): string {
  const frame = typeof call.args.frame === 'number' && call.args.frame !== 0
    ? localized(locale, `, iframe ${call.args.frame}`, `，iframe ${call.args.frame}`)
    : ''
  const index = typeof call.args.index === 'number' ? call.args.index : '?'
  const entries = uploadSummaryEntries(call.args)
  const files = entries.length === 0 ? localized(locale, 'selected files', '所选文件') : entries.join(', ')
  return localized(
    locale,
    `Upload ${entries.length || 'selected'} file(s) to element [${index}]${frame}: ${files}`,
    `上传 ${entries.length || '所选'} 个文件到元素 [${index}]${frame}：${files}`,
  )
}

function uploadSummaryEntries(args: Record<string, unknown>): string[] {
  const metadata = Array.isArray(args.fileMetadata) ? args.fileMetadata : []
  const files = Array.isArray(args.files) ? args.files : []
  return (metadata.length > 0 ? metadata : files).map((entry, index) => {
    if (typeof entry === 'object' && entry !== null) {
      const item = entry as { name?: unknown; size?: unknown }
      const fallbackName = typeof files[index] === 'string' ? files[index] : ''
      const name = fileNameOnly(typeof item.name === 'string' ? item.name : fallbackName)
      const size = typeof item.size === 'number' && Number.isFinite(item.size) && item.size >= 0
        ? `${Math.floor(item.size)} bytes`
        : 'size unavailable'
      return `${safeInline(name, 80)} (${size})`
    }
    return fileNameOnly(typeof entry === 'string' ? entry : '')
  }).filter((entry) => entry !== '')
}

function fileNameOnly(value: string): string {
  const normalized = value.replace(/\\/g, '/').split('/').pop() ?? ''
  return safeInline(normalized || 'unnamed file', 80)
}

function readSummary(call: ToolCall, locale: UiLocale): string {
  switch (call.name) {
    case 'browser_screenshot': return localized(locale, 'Capture a screenshot of the current page', '截取当前页面截图')
    case 'browser_get_table': return localized(locale, 'Extract a table from the current page', '提取当前页面表格')
    case 'browser_list_tabs': return localized(locale, 'List open browser tabs', '列出浏览器标签页')
    case 'browser_network_capture': return localized(locale, 'Capture page network responses', '抓取页面网络响应')
    default: return call.name === 'browser_snapshot'
      ? localized(locale, 'Read the current page and accessible iframes', '读取当前页面及可访问 iframe')
      : localized(locale, 'Read text from the specified area of the current page', '读取当前页面的指定文本区域')
  }
}

function displayUrl(value: string, locale: UiLocale): string {
  try {
    const url = new URL(value)
    return safeInline(`${url.origin}${url.pathname}`, 160)
  } catch {
    return localized(locale, '(invalid URL)', '(无效 URL)')
  }
}

function localized(locale: UiLocale, english: string, chinese: string): string {
  return locale === 'zh' ? chinese : english
}

function safeInline(value: string, maxLength = 40): string {
  const inline = value.replace(/\s+/g, ' ').trim()
  return inline.length <= maxLength ? inline : `${inline.slice(0, maxLength - 1)}…`
}
