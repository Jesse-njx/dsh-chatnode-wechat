/**
 * Inbound bridge: iLink messages → DSH conversation events.
 *
 * Policy enforced here (the security boundary of the bundle):
 * - only `allowFrom` senders are ever routed to the model; everyone else is
 *   logged and ignored (a prompt-injection front door otherwise);
 * - group messages are ignored in MVP (iLink bot identities usually cannot
 *   join ordinary groups anyway — see README risks);
 * - text is extracted from `text_item` (and `voice_item.text` transcription
 *   when WeChat supplied no downloadable audio);
 * - commands are handled locally; everything else becomes a user message on
 *   the active agent via `agent.followup`.
 *
 * @module @dsh-cowork/chatnode-wechat/node/inbound
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ITEM_TEXT, ITEM_VOICE, ITEM_IMAGE, type InboundMessage, type WireItem } from '../gateway/types.ts'
import { imageExt } from '../gateway/media.ts'
import type { WechatConversationNode } from './core.ts'
import { routeCommand } from './commands.ts'
import { sendTextToPeer } from './outbound.ts'

/** Whether a message is a group/room message (MVP: not supported). */
export function isGroupMessage(message: InboundMessage, accountId: string): boolean {
  const roomId = String(message.room_id ?? message.chat_room_id ?? '').trim()
  if (roomId) return true
  const toUserId = String(message.to_user_id ?? '').trim()
  const sender = String(message.from_user_id ?? '').trim()
  return Boolean(toUserId && accountId && toUserId !== accountId && message.msg_type === 1)
}

/** Extract the visible text of an inbound message (text + voice transcription). */
export function extractText(message: InboundMessage): string {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  for (const item of items) {
    if (item?.type === ITEM_TEXT) {
      const text = String(item.text_item?.text ?? '')
      if (text.trim()) return text
    }
  }
  for (const item of items) {
    if (item?.type === ITEM_VOICE) {
      const voiceText = String(item.voice_item?.text ?? '')
      if (voiceText.trim()) {
        // WeChat supplied its own transcription (no downloadable audio in this
        // item); keep the voice origin visible so the model can distinguish it.
        return `[语音转写]\n${voiceText}`
      }
    }
  }
  return ''
}

/** First image item in a message, or null. */
function extractImageItem(message: InboundMessage): WireItem | null {
  const items = Array.isArray(message.item_list) ? message.item_list : []
  for (const item of items) {
    if (item?.type === ITEM_IMAGE && item.image_item?.media) return item
  }
  return null
}

/** Directory inbound images are saved to (configurable, defaults under $DSH_HOME). */
function inboundMediaDir(node: WechatConversationNode): string {
  return node.config.mediaDir
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'attachments', 'wechat')
}

/**
 * Handle an image-only message: download + decrypt, persist to disk, then hand
 * the file path to the active agent so its `read_image`/vision tool can decode
 * it (the default model is text-only and reads images by path, not inline).
 */
async function handleInboundImage(node: WechatConversationNode, sender: string, message: InboundMessage): Promise<void> {
  const imageItem = extractImageItem(message)
  if (!imageItem) return

  let downloaded: { bytes: Uint8Array; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' } | null
  try {
    downloaded = await node.ctx.wechat.downloadImage(imageItem)
  } catch (error) {
    node.ctx.logger?.warn?.(
      '[dsh-chatnode-wechat] image download failed from %s: %s',
      sender, error instanceof Error ? error.message : String(error),
    )
    await sendTextToPeer(node, '❌ 图片下载失败，请重试。')
    return
  }
  if (!downloaded) return

  const dir = inboundMediaDir(node)
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    // directory may already exist; writeFile below still reports real failures
  }
  const name = `wechat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${imageExt(downloaded.mediaType)}`
  const absPath = join(dir, name)
  try {
    await writeFile(absPath, downloaded.bytes)
  } catch (error) {
    node.ctx.logger?.warn?.(
      '[dsh-chatnode-wechat] image save failed: %s',
      error instanceof Error ? error.message : String(error),
    )
    await sendTextToPeer(node, '❌ 图片保存失败，请重试。')
    return
  }

  node.peerId = sender
  const agent = node.activeAgent()
  if (!agent) {
    await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始一个新会话，或 /sessions 查看已有会话。')
    return
  }

  const messageValue = createUserMessage({
    content: [{
      type: 'text',
      text: `[微信图片] ${absPath}\n\n收到一张来自微信的图片，已保存到上述路径。请用 read_image 工具查看并处理。`,
    }],
    source: { kind: 'user' },
  })
  agent.followup(messageValue)
  await node.ctx.wechat.sendTyping(sender, 1).catch(() => {})
}

/** Handle one inbound iLink message. */
export async function handleInbound(node: WechatConversationNode, message: InboundMessage): Promise<void> {
  const sender = String(message.from_user_id ?? '').trim()
  if (!sender) return

  // ---- allowlist gate: the security boundary ------------------------------
  if (!node.isAllowed(sender)) {
    node.ctx.logger?.info?.(
      '[dsh-chatnode-wechat] ignoring message from non-allowlisted sender %s (never fed to the model)',
      sender,
    )
    return
  }
  if (isGroupMessage(message, node.gatewayAccountId)) {
    node.ctx.logger?.info?.('[dsh-chatnode-wechat] ignoring group message from %s (MVP: no group support)', sender)
    return
  }

  const text = extractText(message)
  if (!text.trim()) {
    await handleInboundImage(node, sender, message)
    return
  }

  node.peerId = sender

  // ---- local command handling ---------------------------------------------
  if (await routeCommand(node, text)) return

  // ---- route to the active agent ------------------------------------------
  const agent = node.activeAgent()
  if (!agent) {
    await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始一个新会话，或 /sessions 查看已有会话。')
    return
  }

  const messageValue = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  agent.followup(messageValue)
  await node.ctx.wechat.sendTyping(sender, 1).catch(() => {})
}
