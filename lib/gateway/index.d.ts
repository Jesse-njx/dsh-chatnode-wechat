/**
 * wechat-gateway plugin: the iLink gateway as a Cordis service (`ctx.wechat`).
 *
 * Owns the authenticated long-poll loop, reconnect/backoff, send retry +
 * rate-limit circuit breaker, the per-peer context-token store, inbound
 * dedup, the typing indicator, and the QR login flow. The conversation node
 * (`../node`) consumes this service and never touches iLink directly.
 *
 * Architecture constraints that shape this file:
 * - **Exclusive lock**: iLink allows ONE authenticated poller per bot token.
 *   A second poller (hermes-agent, OpenClaw, or a duplicate of this bundle)
 *   receives 403s. We detect HTTP 403 and stop polling with a loud
 *   coexistence error instead of retrying forever.
 * - **context_token**: every outbound reply must echo the latest token the
 *   peer supplied; a stale token yields `-14` (session expired), after which
 *   a tokenless retry is attempted (iLink accepts it as a degraded fallback).
 * - **Session expiry** (`-14` or `-2`+"unknown error") pauses the poll loop
 *   for a configurable window, mirroring the hermes-agent reference.
 *
 * @module @dsh-cowork/chatnode-wechat/gateway
 */
import { Service, Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type InboundMessage, type WechatCredentials, type WireItem } from './types.ts';
import { type RasterImageMediaType } from './media.ts';
/** Gateway connection lifecycle, surfaced as `wechat/status` events. */
export type GatewayStatus = 'idle' | 'starting' | 'connected' | 'reconnecting' | 'paused' | 'error';
/** Outcome of one outbound text delivery. */
export interface SendResult {
    success: boolean;
    messageId?: string;
    error?: string;
}
/** Result of a QR login performed through the service. */
export interface LoginResult {
    success: boolean;
    credentials?: WechatCredentials;
    error?: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** The iLink gateway service provided by the wechat-gateway plugin. */
        wechat: WechatGateway;
    }
    interface Events {
        /** One inbound iLink message, deduplicated and sender-filtered at the gateway. */
        'wechat/message'(message: InboundMessage): void;
        /** Gateway connection status changed. */
        'wechat/status'(status: GatewayStatus): void;
        /** A non-fatal gateway error (logged, poll continues). */
        'wechat/error'(error: Error): void;
        /** A fatal gateway error (polling stopped; e.g. exclusive-lock 403). */
        'wechat/fatal'(error: Error): void;
    }
}
/** Plugin config. `token`/`accountId` normally come from dsh credentials. */
export interface Config {
    /** iLink gateway base url. */
    baseUrl?: string;
    /** WeChat CDN base url for media. */
    cdnBaseUrl?: string;
    /** Bot token (Bearer). Resolved per operation when credentials are wired. */
    token?: string;
    /** Bot account id. */
    accountId?: string;
    /** Long-poll window for getUpdates. */
    longPollTimeoutMs?: number;
    /** Per-request API timeout. */
    apiTimeoutMs?: number;
    /** Idle pause between poll iterations (0 = rely on server long-poll). */
    pollIdleDelayMs?: number;
    /** Poll interval while waiting for QR scan (ms). */
    qrPollIntervalMs?: number;
    /** Delay before a failed poll retry. */
    retryDelayMs?: number;
    /** Delay after `maxConsecutiveFailures`. */
    backoffDelayMs?: number;
    /** Consecutive failures before backoff applies. */
    maxConsecutiveFailures?: number;
    /** Pause duration when the session expires. */
    sessionExpiredPauseMs?: number;
    /** Delay between outbound chunks. */
    sendChunkDelayMs?: number;
    /** Retry budget for one outbound chunk. */
    sendChunkRetries?: number;
    /** Base delay between chunk retries. */
    sendChunkRetryDelayMs?: number;
    /** Rate-limit circuit: open for this long after threshold hits. */
    rateLimitCircuitOpenMs?: number;
    /** Rate-limit circuit: hits inside this window trip it. */
    rateLimitCircuitWindowMs?: number;
    /** Rate-limit circuit: hits inside this window trip it. */
    rateLimitCircuitThreshold?: number;
    /** CDN hosts the media downloader may fetch (SSRF guard). */
    allowCdnHosts?: string[];
}
export declare const Config: z<Schemastery.ObjectS<{
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
    longPollTimeoutMs: z<number, number>;
    apiTimeoutMs: z<number, number>;
    pollIdleDelayMs: z<number, number>;
    qrPollIntervalMs: z<number, number>;
    retryDelayMs: z<number, number>;
    backoffDelayMs: z<number, number>;
    maxConsecutiveFailures: z<number, number>;
    sessionExpiredPauseMs: z<number, number>;
    sendChunkDelayMs: z<number, number>;
    sendChunkRetries: z<number, number>;
    sendChunkRetryDelayMs: z<number, number>;
    rateLimitCircuitOpenMs: z<number, number>;
    rateLimitCircuitWindowMs: z<number, number>;
    rateLimitCircuitThreshold: z<number, number>;
    allowCdnHosts: z<string[], string[]>;
}>, Schemastery.ObjectT<{
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
    longPollTimeoutMs: z<number, number>;
    apiTimeoutMs: z<number, number>;
    pollIdleDelayMs: z<number, number>;
    qrPollIntervalMs: z<number, number>;
    retryDelayMs: z<number, number>;
    backoffDelayMs: z<number, number>;
    maxConsecutiveFailures: z<number, number>;
    sessionExpiredPauseMs: z<number, number>;
    sendChunkDelayMs: z<number, number>;
    sendChunkRetries: z<number, number>;
    sendChunkRetryDelayMs: z<number, number>;
    rateLimitCircuitOpenMs: z<number, number>;
    rateLimitCircuitWindowMs: z<number, number>;
    rateLimitCircuitThreshold: z<number, number>;
    allowCdnHosts: z<string[], string[]>;
}>>;
type ResolvedConfig = Required<Config>;
/**
 * The iLink gateway service. Register with `ctx.plugin(WechatGateway, config)`;
 * consumers inject `wechat` and subscribe to `wechat/message`.
 */
export declare class WechatGateway extends Service {
    static Config: z<Schemastery.ObjectS<{
        baseUrl: z<string, string>;
        cdnBaseUrl: z<string, string>;
        token: z<string, string>;
        accountId: z<string, string>;
        longPollTimeoutMs: z<number, number>;
        apiTimeoutMs: z<number, number>;
        pollIdleDelayMs: z<number, number>;
        qrPollIntervalMs: z<number, number>;
        retryDelayMs: z<number, number>;
        backoffDelayMs: z<number, number>;
        maxConsecutiveFailures: z<number, number>;
        sessionExpiredPauseMs: z<number, number>;
        sendChunkDelayMs: z<number, number>;
        sendChunkRetries: z<number, number>;
        sendChunkRetryDelayMs: z<number, number>;
        rateLimitCircuitOpenMs: z<number, number>;
        rateLimitCircuitWindowMs: z<number, number>;
        rateLimitCircuitThreshold: z<number, number>;
        allowCdnHosts: z<string[], string[]>;
    }>, Schemastery.ObjectT<{
        baseUrl: z<string, string>;
        cdnBaseUrl: z<string, string>;
        token: z<string, string>;
        accountId: z<string, string>;
        longPollTimeoutMs: z<number, number>;
        apiTimeoutMs: z<number, number>;
        pollIdleDelayMs: z<number, number>;
        qrPollIntervalMs: z<number, number>;
        retryDelayMs: z<number, number>;
        backoffDelayMs: z<number, number>;
        maxConsecutiveFailures: z<number, number>;
        sessionExpiredPauseMs: z<number, number>;
        sendChunkDelayMs: z<number, number>;
        sendChunkRetries: z<number, number>;
        sendChunkRetryDelayMs: z<number, number>;
        rateLimitCircuitOpenMs: z<number, number>;
        rateLimitCircuitWindowMs: z<number, number>;
        rateLimitCircuitThreshold: z<number, number>;
        allowCdnHosts: z<string[], string[]>;
    }>>;
    readonly c: ResolvedConfig;
    private syncBuf;
    private pollTask;
    private stopPolling;
    private statusValue;
    private readonly contextTokens;
    private readonly dedup;
    private readonly typingTickets;
    private rateLimitHits;
    private rateLimitUntil;
    constructor(ctx: Context, config: Config);
    /** Current gateway status. */
    get status(): GatewayStatus;
    /** Whether credentials are present (polling is possible). */
    get configured(): boolean;
    /** The bot account id. */
    get accountId(): string;
    /** The resolved gateway base url. */
    get baseUrl(): string;
    /** Replace credentials at runtime and restart the poll loop. */
    setCredentials(credentials: {
        token?: string;
        accountId?: string;
        baseUrl?: string;
    }): void;
    /** Start (or restart) the poll loop if credentials exist. */
    start(): Promise<void>;
    /** Stop the poll loop (idempotent). */
    stop(): Promise<void>;
    /** Cached context token for a peer, or undefined. */
    contextTokenFor(peerId: string): string | undefined;
    /** Record (or replace) the context token a peer supplied. */
    setContextToken(peerId: string, token: string): void;
    /**
     * Run the QR login flow. The returned credentials are NOT persisted here —
     * the caller (login script / conversation node) stores them through
     * `ctx.credentials`. On success the gateway adopts them and starts polling.
     */
    loginQr(opts: {
        onQr?: (qr: {
            value: string;
            scanData: string;
            imgContent?: string;
        }) => void;
        onStatus?: (status: string) => void;
        timeoutMs?: number;
    }): Promise<LoginResult>;
    /**
     * Send one text message to a peer with per-chunk retry, session-expired
     * tokenless fallback, and a rate-limit circuit breaker. Chunking long
     * content into <= `maxMessageChars` bubbles is the conversation node's job
     * (`../node/outbound.ts`); this method sends exactly one bubble.
     */
    sendText(to: string, text: string, clientId?: string): Promise<SendResult>;
    /**
     * Download and decrypt one inbound image item into raw bytes. Uses the
     * gateway's configured CDN base + allowlist so the node layer never touches
     * the wire or the SSRF guard directly.
     * @returns decoded bytes and detected media type, or null when the item
     *   carries no usable media reference.
     */
    downloadImage(item: WireItem): Promise<{
        bytes: Uint8Array;
        mediaType: RasterImageMediaType;
    } | null>;
    /**
     * Send one image file to a peer: AES-encrypt → getuploadurl ticket → upload
     * ciphertext to the CDN → sendmessage with an image item. Uses the peer's
     * cached context_token (the wire REQUIRES it — tokenless sends fail with
     * ret=-2 "prepare failed"), with session-expired and rate-limit handling
     * mirroring {@link sendText}.
     */
    sendImage(to: string, filePath: string): Promise<SendResult>;
    /** Show or hide the typing indicator for a peer (best-effort). */
    sendTyping(to: string, status: 1 | 2): Promise<void>;
    /** Fetch (or refresh) the 600s-TTL typing ticket for a peer. */
    private typingTicket;
    private restart;
    private setStatus;
    private runPollLoop;
    private dispatchInbound;
    private isDuplicate;
    private remember;
    private recordRateLimit;
}
export default WechatGateway;
//# sourceMappingURL=index.d.ts.map