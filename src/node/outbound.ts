/**
 * Outbound bridge: session events → WeChat messages.
 *
 * The conversation node never mirrors every tool call. It emits a small
 * digest vocabulary from the append-only session log:
 *
 * - task started   (`user/message` / `turn/start`)
 * - heartbeat      (one line every `digestIntervalSec` while a turn is open)
 * - assistant text (`assistant/message` — the real payload, chunked)
 * - finished/error (`turn/end`)
 *
 * Long assistant text is chunked to WeChat bubble size (2000 chars) with a
 * throttle between bubbles, mirroring the hermes-agent reference splitting.
 *
 * @module @dsh-cowork/chatnode-wechat/node/outbound
 */

import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { MAX_MESSAGE_CHARS } from '../gateway/types.ts'
import type { WechatConversationNode } from './core.ts'
import { sessionBadge } from './labels.ts'

// ---------------------------------------------------------------------------
// Chunking (port of hermes-agent `_split_text_for_weixin_delivery`, compact)
// ---------------------------------------------------------------------------

const FENCE_RE = /^```([^\n`]*)\s*$/

/** Collapse runs of blank lines to one; strips surrounding whitespace. */
export function normalizeMarkdownBlocks(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let blankRun = 0
  let inCode = false
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (FENCE_RE.test(line.trim())) {
      inCode = !inCode
      out.push(line)
      blankRun = 0
      continue
    }
    if (inCode) {
      out.push(line)
      continue
    }
    if (!line.trim()) {
      blankRun += 1
      if (blankRun <= 1) out.push('')
      continue
    }
    blankRun = 0
    out.push(line)
  }
  return out.join('\n').trim()
}

/** Split content into markdown blocks, keeping fenced code blocks intact. */
export function splitMarkdownBlocks(content: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let inCode = false

  const flush = () => {
    const block = current.join('\n').trim()
    if (block) blocks.push(block)
    current = []
  }

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (FENCE_RE.test(line.trim())) {
      if (!inCode && current.length) flush()
      current.push(line)
      inCode = !inCode
      if (!inCode) flush()
      continue
    }
    if (inCode) {
      current.push(line)
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  return blocks
}

/** Split one oversized block into ≤max chunks (hard-truncating the tail). */
function hardSplit(text: string, max: number): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    chunks.push(rest.slice(0, max))
    rest = rest.slice(max)
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** Greedy-pack markdown blocks into ≤max units. */
function packBlocks(blocks: string[], max: number): string[] {
  const units: string[] = []
  let current = ''
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block
    if (candidate.length <= max) {
      current = candidate
      continue
    }
    if (current) units.push(current)
    if (block.length <= max) {
      current = block
    } else {
      units.push(...hardSplit(block, max))
      current = ''
    }
  }
  if (current) units.push(current)
  return units
}

/** Whether a block reads as a short chatty exchange worth separate bubbles. */
function shouldSplitShortChat(block: string): boolean {
  const lines = block.split('\n').filter((l) => l.trim())
  if (lines.length < 2 || lines.length > 6) return false
  if (lines[0]!.length <= 24 && /[:：]$/.test(lines[0]!.trim())) return false
  return lines.every((l) => {
    const s = l.trim()
    if (!s) return false
    if (s.length > 48) return false
    if (s.startsWith(' ') || s.startsWith('\t')) return false
    if (/^[>#*\-|【]/.test(s)) return false
    return true
  })
}

/** Split assistant text into WeChat delivery units (≤max each). */
export function splitForWechat(content: string, max: number = MAX_MESSAGE_CHARS): string[] {
  const normalized = normalizeMarkdownBlocks(content)
  if (!normalized) return []
  if (normalized.length <= max) {
    if (shouldSplitShortChat(normalized)) {
      const units = splitMarkdownBlocks(normalized)
      return units.filter((u) => u.length <= max)
    }
    return [normalized]
  }
  return packBlocks(splitMarkdownBlocks(normalized), max)
}

/** Extract the visible text of an assistant message. */
export function textOfAssistantMessage(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Digest summary
// ---------------------------------------------------------------------------

/** One-line progress summary derived from the session log (cheap, replayable). */
export function digestLine(session: Session, badge?: string): string {
  let turn = 0
  let tools = 0
  let lastTool: string | undefined
  let inTurn = false
  for (const event of session.events) {
    if (event.type === 'turn/start') {
      turn = event.data.turn
      inTurn = true
      tools = 0
      lastTool = undefined
    } else if (event.type === 'turn/end') {
      inTurn = false
    } else if (event.type === 'tool/call' && inTurn) {
      tools += 1
      lastTool = event.data.name
    }
  }
  const steps = tools > 0 ? `${tools} 个工具调用` : '思考中'
  const last = lastTool ? ` · 最近: ${lastTool}` : ''
  const prefix = badge ? `${badge} ` : ''
  return `${prefix}🔄 仍在处理中…（第 ${turn} 轮 · ${steps}${last}）`
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Send text to the current peer, chunked and throttled. */
export async function sendTextToPeer(node: WechatConversationNode, text: string): Promise<void> {
  const peer = node.peerId
  if (!peer) return
  const chunks = splitForWechat(text, node.config.maxMessageChars)
  if (chunks.length === 0) return
  await node.ctx.wechat.sendTyping(peer, 1).catch(() => {})
  try {
    for (let i = 0; i < chunks.length; i++) {
      const result = await node.ctx.wechat.sendText(peer, chunks[i]!)
      if (!result.success) {
        node.ctx.logger?.warn?.('[dsh-chatnode-wechat] outbound chunk %d/%d failed: %s', i + 1, chunks.length, result.error)
        break
      }
      if (i < chunks.length - 1 && node.config.sendChunkDelayMs > 0) {
        await sleep(node.config.sendChunkDelayMs)
      }
    }
  } finally {
    await node.ctx.wechat.sendTyping(peer, 2).catch(() => {})
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Session-event wiring
// ---------------------------------------------------------------------------

interface DigestState {
  startedTurns: Set<number>
  heartbeat?: ReturnType<typeof setInterval>
}

/**
 * Attach the outbound digest pipeline. Listens on `session/event` once and
 * filters to the node's active session, so switching sessions mid-flight is
 * safe (per-session digest state is keyed by session id).
 */
export function attachSessionOutbound(node: WechatConversationNode): () => void {
  const digestState = new Map<string, DigestState>()

  const stopHeartbeat = (state: DigestState) => {
    if (state.heartbeat) {
      clearInterval(state.heartbeat)
      state.heartbeat = undefined
    }
  }

  const startHeartbeat = (session: Session, state: DigestState) => {
    stopHeartbeat(state)
    if (node.config.digestIntervalSec <= 0) return
    state.heartbeat = setInterval(() => {
      void sendTextToPeer(node, digestLine(session, sessionBadge(node, session)))
    }, node.config.digestIntervalSec * 1000)
    state.heartbeat.unref?.()
  }

  const onEvent = (session: Session, event: SessionEvent): void => {
    if (session.id !== node.activeSessionId) return
    const state = digestState.get(session.id) ?? { startedTurns: new Set<number>() }
    digestState.set(session.id, state)

    if (event.type === 'turn/start') {
      const turn = event.data.turn
      if (!state.startedTurns.has(turn)) {
        state.startedTurns.add(turn)
        void sendTextToPeer(node, `⏳ ${sessionBadge(node, session)} 收到，开始处理…`)
      }
      startHeartbeat(session, state)
      return
    }
    if (event.type === 'assistant/message') {
      const text = textOfAssistantMessage(event.data.message)
      if (text.trim()) void sendTextToPeer(node, text)
      return
    }
    if (event.type === 'turn/end') {
      stopHeartbeat(state)
      const reason = event.data.reason
      if (reason.kind === 'error') {
        void sendTextToPeer(node, `❌ ${sessionBadge(node, session)} 处理出错: ${summarizeError(reason.error)}`)
      } else if (reason.kind === 'aborted') {
        void sendTextToPeer(node, `⏹ ${sessionBadge(node, session)} 已停止`)
      } else if (reason.kind === 'max-tokens') {
        void sendTextToPeer(node, `⚠️ ${sessionBadge(node, session)} 达到输出上限，本轮已截断`)
      }
      return
    }
  }

  const listener = (session: Session, event: SessionEvent): void => onEvent(session, event)
  const disposer = node.ctx.on('session/event', listener)
  return () => {
    for (const state of digestState.values()) stopHeartbeat(state)
    disposer()
  }
}

function summarizeError(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message).slice(0, 200)
  }
  return String(error).slice(0, 200)
}
