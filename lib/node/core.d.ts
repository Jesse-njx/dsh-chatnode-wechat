/**
 * WechatConversationNode — the orchestration state behind the
 * `wechat-conversation-node` plugin.
 *
 * Holds session targeting, the allowlist, pending approvals, and wires the
 * inbound/outbound/command/approval bridges onto the Cordis context.
 *
 * @module @dsh-cowork/chatnode-wechat/node/core
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { PendingApproval } from './approvals.ts';
/** Runtime shape of the node plugin's config (defaults applied). */
export interface NodeConfig {
    /** Hard allowlist of WeChat sender ids allowed to drive the agent. REQUIRED. */
    allowFrom: string[];
    /** Heartbeat interval for progress digests (seconds; 0 disables). */
    digestIntervalSec: number;
    /** Approval prompt timeout before default-deny (seconds). */
    approvalTimeoutSec: number;
    /** Max chars per WeChat bubble. */
    maxMessageChars: number;
    /** Throttle between outbound bubbles (ms). */
    sendChunkDelayMs: number;
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
export declare class WechatConversationNode {
    /** The active session the WeChat user drives. */
    activeSessionId: SessionId | null;
    /** The allowlisted peer outbound text goes to (last inbound sender). */
    peerId: string | null;
    private readonly pending;
    private approvalCounter;
    private disposers;
    readonly ctx: Context;
    readonly config: NodeConfig;
    constructor(ctx: Context, config: NodeConfig);
    /** The active session, if any. */
    activeSession(): Session | undefined;
    /** The agent driving the active session, if any. */
    activeAgent(): Agent | undefined;
    /** Whether this node drives the given agent (its session is active). */
    ownsAgent(agent: Agent): boolean;
    /** Whether a sender is allowlisted. */
    isAllowed(senderId: string): boolean;
    /** The gateway's own account id (used for group detection). */
    get gatewayAccountId(): string;
    /** Switch the active session and reply confirmation to the peer. */
    setActiveSession(session: Session): void;
    /** Pick the most recent session as the default (zero-config targeting). */
    pickDefaultSession(): void;
    /** Create a fresh agent+session via the agent factory and make it active. */
    createSession(prompt: string): Promise<void>;
    nextApprovalNumber(): number;
    registerApproval(number: number, approval: PendingApproval): void;
    clearApproval(number: number): void;
    /**
     * Resolve a pending approval from a WeChat reply. `/yes` and `/no` answer
     * the most recent pending request; bare `1`/`2` only while exactly one is
     * pending (1 = allow, 2 = reject). Returns false when the text is not an
     * approval reply.
     */
    resolveApproval(text: string): boolean;
    /** Tear down all registered listeners (called on plugin dispose). */
    dispose(): void;
}
//# sourceMappingURL=core.d.ts.map