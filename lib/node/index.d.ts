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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Plugin config. `allowFrom` is REQUIRED and validated at apply time. */
export interface Config {
    /** Hard allowlist of WeChat sender ids. REQUIRED — no permissive default. */
    allowFrom?: string[];
    /** Heartbeat interval for progress digests (seconds; 0 disables). */
    digestIntervalSec?: number;
    /** Approval prompt timeout before default-deny (seconds). */
    approvalTimeoutSec?: number;
    /** Max chars per WeChat bubble. */
    maxMessageChars?: number;
    /** Throttle between outbound bubbles (ms). */
    sendChunkDelayMs?: number;
    /** Working directory for `/new` sessions. */
    cwd?: string;
    /** Directory inbound images are saved to (defaults under $DSH_HOME). */
    mediaDir?: string;
    /** Agent preset name for `/new` sessions. */
    agentPreset?: string;
    /** Provider route for `/new` agents. */
    agentProvider?: string;
    /** Model id for `/new` agents. */
    agentModel?: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    allowFrom: z<string[], string[]>;
    digestIntervalSec: z<number, number>;
    approvalTimeoutSec: z<number, number>;
    maxMessageChars: z<number, number>;
    sendChunkDelayMs: z<number, number>;
    cwd: z<string, string>;
    mediaDir: z<string, string>;
    agentPreset: z<string, string>;
    agentProvider: z<string, string>;
    agentModel: z<string, string>;
}>, Schemastery.ObjectT<{
    allowFrom: z<string[], string[]>;
    digestIntervalSec: z<number, number>;
    approvalTimeoutSec: z<number, number>;
    maxMessageChars: z<number, number>;
    sendChunkDelayMs: z<number, number>;
    cwd: z<string, string>;
    mediaDir: z<string, string>;
    agentPreset: z<string, string>;
    agentProvider: z<string, string>;
    agentModel: z<string, string>;
}>>;
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "dsh-chatnode-wechat";
/** Services required by the conversation node. */
export declare const inject: string[];
/** Mount the conversation node on a context that already provides `wechat`. */
export declare function apply(ctx: Context, config: Config): void;
/** The conversation-node plugin object (mountable via `ctx.plugin`). */
export declare const wechatConversationNode: {
    name: string;
    inject: string[];
    Config: z<Schemastery.ObjectS<{
        allowFrom: z<string[], string[]>;
        digestIntervalSec: z<number, number>;
        approvalTimeoutSec: z<number, number>;
        maxMessageChars: z<number, number>;
        sendChunkDelayMs: z<number, number>;
        cwd: z<string, string>;
        mediaDir: z<string, string>;
        agentPreset: z<string, string>;
        agentProvider: z<string, string>;
        agentModel: z<string, string>;
    }>, Schemastery.ObjectT<{
        allowFrom: z<string[], string[]>;
        digestIntervalSec: z<number, number>;
        approvalTimeoutSec: z<number, number>;
        maxMessageChars: z<number, number>;
        sendChunkDelayMs: z<number, number>;
        cwd: z<string, string>;
        mediaDir: z<string, string>;
        agentPreset: z<string, string>;
        agentProvider: z<string, string>;
        agentModel: z<string, string>;
    }>>;
    apply: typeof apply;
};
export { WechatConversationNode, type NodeConfig } from './core.ts';
export { splitForWechat, digestLine, textOfAssistantMessage } from './outbound.ts';
export { extractText, isGroupMessage } from './inbound.ts';
export { listSessions } from './commands.ts';
//# sourceMappingURL=index.d.ts.map