/**
 * wechat-conversation-node plugin: WeChat ⇄ DSH conversation bridge.
 *
 * Consumes the `wechat` gateway service, the `sessions` store, the `agents`
 * registry, the `approval` seam, and the `sessionTitle` service (status
 * messages carry the real session title with a first-prompt fallback).
 * Inbound WeChat text becomes a user message on the active session; session
 * events become digest-style WeChat messages (task started, heartbeat,
 * assistant text chunked, finished/error). Commands
 * (`/sessions /use /new /stop /status /yes /no`) are handled locally. The
 * allowlist gate lives here — non-allowlisted senders are never fed to the
 * model.
 *
 * @module @dsh-cowork/chatnode-wechat/node
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MAX_MESSAGE_CHARS } from "../gateway/types.js";
import { WechatConversationNode } from "./core.js";
export const Config = z.object({
    allowFrom: z.array(z.string()).default([]),
    digestIntervalSec: z.number().default(300),
    approvalTimeoutSec: z.number().default(600),
    maxMessageChars: z.number().default(MAX_MESSAGE_CHARS),
    sendChunkDelayMs: z.number().default(1_500),
    cwd: z.string(),
    mediaDir: z.string(),
    agentPreset: z.string(),
    agentProvider: z.string(),
    agentModel: z.string(),
});
/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-chatnode-wechat';
/** Services required by the conversation node. */
export const inject = ['wechat', 'sessions', 'agents', 'approval', 'tools', 'sessionTitle'];
/** Mount the conversation node on a context that already provides `wechat`. */
export function apply(ctx, config) {
    const node = new WechatConversationNode(ctx, config);
    ctx.effect(() => {
        return () => node.dispose();
    });
    const unregisterTool = ctx.tools.register(defineTool({
        name: 'wechat_send_image',
        description: 'Send a local image file to the current WeChat peer through the chatnode-wechat bridge. ' +
            'The peer is the last WeChat contact who messaged the bot, so at least one inbound WeChat ' +
            'message must have arrived since the profile started. Pass the absolute path of the image file.',
        parameters: {
            path: { type: 'string', required: true, description: 'Absolute path to the image file (jpg/png/webp/gif).' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: async (args) => {
            const path = typeof args.path === 'string' ? args.path.trim() : '';
            if (!path)
                throw new Error('wechat_send_image: path is required');
            const peer = node.peerId;
            if (!peer) {
                throw new Error('wechat_send_image: no WeChat peer yet — send the bot a WeChat message first ' +
                    'so the bridge knows who to reply to');
            }
            const result = await node.ctx.wechat.sendImage(peer, path);
            if (!result.success)
                throw new Error(`wechat_send_image: ${result.error}`);
            return `✅ 图片已发送到微信: ${path}`;
        },
        timeoutMs: 180_000,
    }));
    ctx.effect(() => {
        return () => unregisterTool();
    });
}
/** The conversation-node plugin object (mountable via `ctx.plugin`). */
export const wechatConversationNode = { name, inject, Config, apply };
export { WechatConversationNode } from "./core.js";
export { splitForWechat, digestLine, textOfAssistantMessage } from "./outbound.js";
export { extractText, isGroupMessage } from "./inbound.js";
export { listSessions } from "./commands.js";
//# sourceMappingURL=index.js.map