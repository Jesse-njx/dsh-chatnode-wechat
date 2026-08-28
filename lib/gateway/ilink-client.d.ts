/**
 * Minimal iLink bot API client.
 *
 * A faithful TypeScript port of the hermes-agent WeChat channel protocol
 * (`gateway/platforms/weixin.py`). Endpoints, headers, error codes, and
 * timeouts below match that reference; see `types.ts` for the constants.
 *
 * The client is deliberately transport-light: it owns one POST/GET envelope
 * (`base_info`, headers) and the response envelope parsing. The polling loop,
 * reconnect/backoff policy, and send retry/circuit logic live in the gateway
 * service (`index.ts`).
 *
 * @module @dsh-cowork/chatnode-wechat/gateway/ilink-client
 */
import { type GetUpdatesResponse, type QrCodeResponse, type QrStatusResponse, type SendMessageResponse, type WechatCredentials, type InboundMessage } from './types.ts';
/** Result of one getUpdates call, normalized for the polling loop. */
export interface UpdatesBatch {
    /** Messages received in this window (empty on timeout). */
    messages: InboundMessage[];
    /** Opaque continuation cursor; must be echoed on the next call. */
    syncBuf: string;
    /** Server-suggested long-poll timeout, when the server sent one. */
    suggestedTimeoutMs?: number;
    /** Raw envelope for error inspection. */
    raw: GetUpdatesResponse;
}
/** A structured transport failure carrying the raw response when present. */
export declare class IlinkError extends Error {
    readonly ret?: number;
    readonly errcode?: number;
    readonly raw?: unknown;
    constructor(message: string, opts?: {
        ret?: number;
        errcode?: number;
        raw?: unknown;
    });
}
interface PostOptions {
    baseUrl?: string;
    endpoint: string;
    payload: Record<string, unknown>;
    token?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
/** POST one JSON envelope and parse the response object. */
export declare function postJson<T = Record<string, unknown>>(opts: PostOptions): Promise<T>;
interface GetOptions {
    baseUrl?: string;
    endpoint: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}
/** GET one endpoint (QR endpoints are tokenless GETs). */
export declare function getJson<T = Record<string, unknown>>(opts: GetOptions): Promise<T>;
/** Long-poll getUpdates; a timeout returns an empty batch (not an error). */
export declare function getUpdates(opts: {
    baseUrl?: string;
    token: string;
    syncBuf: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<UpdatesBatch>;
/** Send one text message to a peer. */
export declare function sendMessage(opts: {
    baseUrl?: string;
    token: string;
    to: string;
    text: string;
    contextToken?: string;
    clientId: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<SendMessageResponse>;
/** Request a CDN upload ticket for one media file. */
export declare function getUploadUrl(opts: {
    baseUrl?: string;
    token: string;
    to: string;
    mediaType: number;
    filekey: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskeyHex: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<{
    uploadParam?: string;
    uploadFullUrl?: string;
}>;
/**
 * Upload encrypted media bytes to the WeChat CDN.
 * POST first; a 404 falls back to PUT (the CDN changed its method at some
 * point). The download key is returned in the `x-encrypted-param` response
 * header; when the header is missing the filekey itself is the key (per the
 * hermes-agent reference).
 */
export declare function uploadCiphertext(opts: {
    uploadUrl: string;
    ciphertext: Uint8Array;
    filekey: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<string>;
/** Send one image-item message to a peer. */
export declare function sendImageMessage(opts: {
    baseUrl?: string;
    token: string;
    to: string;
    encryptQueryParam: string;
    /** base64(ascii(hex(aesKey))) — NOT base64(raw key bytes). */
    aesKeyB64Hex: string;
    ciphertextSize: number;
    contextToken?: string;
    clientId: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<SendMessageResponse>;
/** Fetch the per-peer typing ticket (600s TTL) used by sendTyping. */
export declare function getConfig(opts: {
    baseUrl?: string;
    token: string;
    userId: string;
    contextToken?: string;
    fetchImpl?: typeof fetch;
}): Promise<{
    typingTicket?: string;
}>;
/** Start (1) or stop (2) the typing indicator for a peer. */
export declare function sendTyping(opts: {
    baseUrl?: string;
    token: string;
    toUserId: string;
    typingTicket: string;
    status: 1 | 2;
    fetchImpl?: typeof fetch;
}): Promise<void>;
/** Fetch the QR login material (bot_type=3 = personal-account bot). */
export declare function getBotQrcode(opts: {
    baseUrl?: string;
    botType?: string;
    fetchImpl?: typeof fetch;
}): Promise<QrCodeResponse>;
/** Poll the QR login status. */
export declare function getQrcodeStatus(opts: {
    baseUrl?: string;
    qrcode: string;
    fetchImpl?: typeof fetch;
}): Promise<QrStatusResponse>;
/**
 * Run the interactive QR login flow: fetch a QR, poll its status until
 * `confirmed`, and resolve credentials. Callbacks let a caller render the QR
 * (URL/ASCII) and observe status transitions (scan, redirect, expiry).
 *
 * @returns credentials, or `null` when login failed or timed out.
 */
export declare function qrLogin(opts: {
    baseUrl?: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
    onQr?: (qr: {
        value: string;
        scanData: string;
        imgContent?: string;
    }) => void;
    onStatus?: (status: string, detail?: QrStatusResponse) => void;
    fetchImpl?: typeof fetch;
}): Promise<WechatCredentials | null>;
/** Cancel-safe sleep helper. */
export declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;
export {};
//# sourceMappingURL=ilink-client.d.ts.map