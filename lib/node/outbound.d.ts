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
import type { AssistantMessage } from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { WechatConversationNode } from './core.ts';
/** Collapse runs of blank lines to one; strips surrounding whitespace. */
export declare function normalizeMarkdownBlocks(content: string): string;
/** Split content into markdown blocks, keeping fenced code blocks intact. */
export declare function splitMarkdownBlocks(content: string): string[];
/** Split assistant text into WeChat delivery units (≤max each). */
export declare function splitForWechat(content: string, max?: number): string[];
/** Extract the visible text of an assistant message. */
export declare function textOfAssistantMessage(message: AssistantMessage): string;
/** One-line progress summary derived from the session log (cheap, replayable). */
export declare function digestLine(session: Session, badge?: string): string;
/** Send text to the current peer, chunked and throttled. */
export declare function sendTextToPeer(node: WechatConversationNode, text: string): Promise<void>;
/**
 * Attach the outbound digest pipeline. Listens on `session/event` once and
 * filters to the node's active session, so switching sessions mid-flight is
 * safe (per-session digest state is keyed by session id).
 */
export declare function attachSessionOutbound(node: WechatConversationNode): () => void;
//# sourceMappingURL=outbound.d.ts.map