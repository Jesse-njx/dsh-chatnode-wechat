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

import { randomBytes, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Service, Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  API_TIMEOUT_MS,
  CONFIG_TIMEOUT_MS,
  ILINK_BASE_URL,
  LONG_POLL_TIMEOUT_MS,
  MEDIA_IMAGE,
  MESSAGE_DEDUP_TTL_SECONDS,
  RATE_LIMIT_ERRCODE,
  SESSION_EXPIRED_ERRCODE,
  WEIXIN_CDN_BASE_URL,
  isStaleSessionRet,
  type InboundMessage,
  type WechatCredentials,
  type WireItem,
} from './types.ts'
import {
  getConfig,
  getUpdates,
  getUploadUrl,
  qrLogin,
  sendMessage,
  sendImageMessage,
  sendTyping as sendTypingRaw,
  sleep,
  uploadCiphertext,
  type UpdatesBatch,
} from './ilink-client.ts'
import {
  DEFAULT_CDN_ALLOWLIST,
  downloadMedia,
  detectImageMediaType,
  aes128EcbEncrypt,
  cdnUploadUrl,
  type RasterImageMediaType,
} from './media.ts'

/** Gateway connection lifecycle, surfaced as `wechat/status` events. */
export type GatewayStatus =
  | 'idle'        // no credentials configured; not polling
  | 'starting'    // poll loop starting
  | 'connected'   // poll loop active
  | 'reconnecting'// transient failure, backing off
  | 'paused'      // session expired; waiting out the pause window
  | 'error'       // fatal (e.g. exclusive-lock 403); polling stopped

/** Outcome of one outbound text delivery. */
export interface SendResult {
  success: boolean
  messageId?: string
  error?: string
}

/** Result of a QR login performed through the service. */
export interface LoginResult {
  success: boolean
  credentials?: WechatCredentials
  error?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The iLink gateway service provided by the wechat-gateway plugin. */
    wechat: WechatGateway
  }
  interface Events {
    /** One inbound iLink message, deduplicated and sender-filtered at the gateway. */
    'wechat/message'(message: InboundMessage): void
    /** Gateway connection status changed. */
    'wechat/status'(status: GatewayStatus): void
    /** A non-fatal gateway error (logged, poll continues). */
    'wechat/error'(error: Error): void
    /** A fatal gateway error (polling stopped; e.g. exclusive-lock 403). */
    'wechat/fatal'(error: Error): void
  }
}

/** Plugin config. `token`/`accountId` normally come from dsh credentials. */
export interface Config {
  /** iLink gateway base url. */
  baseUrl?: string
  /** WeChat CDN base url for media. */
  cdnBaseUrl?: string
  /** Bot token (Bearer). Resolved per operation when credentials are wired. */
  token?: string
  /** Bot account id. */
  accountId?: string
  /** Long-poll window for getUpdates. */
  longPollTimeoutMs?: number
  /** Per-request API timeout. */
  apiTimeoutMs?: number
  /** Idle pause between poll iterations (0 = rely on server long-poll). */
  pollIdleDelayMs?: number
  /** Poll interval while waiting for QR scan (ms). */
  qrPollIntervalMs?: number
  /** Delay before a failed poll retry. */
  retryDelayMs?: number
  /** Delay after `maxConsecutiveFailures`. */
  backoffDelayMs?: number
  /** Consecutive failures before backoff applies. */
  maxConsecutiveFailures?: number
  /** Pause duration when the session expires. */
  sessionExpiredPauseMs?: number
  /** Delay between outbound chunks. */
  sendChunkDelayMs?: number
  /** Retry budget for one outbound chunk. */
  sendChunkRetries?: number
  /** Base delay between chunk retries. */
  sendChunkRetryDelayMs?: number
  /** Rate-limit circuit: open for this long after threshold hits. */
  rateLimitCircuitOpenMs?: number
  /** Rate-limit circuit: hits inside this window trip it. */
  rateLimitCircuitWindowMs?: number
  /** Rate-limit circuit: hits inside this window trip it. */
  rateLimitCircuitThreshold?: number
  /** CDN hosts the media downloader may fetch (SSRF guard). */
  allowCdnHosts?: string[]
}

export const Config = z.object({
  baseUrl: z.string().default(ILINK_BASE_URL),
  cdnBaseUrl: z.string().default(WEIXIN_CDN_BASE_URL),
  token: z.string().default(''),
  accountId: z.string().default(''),
  longPollTimeoutMs: z.number().default(LONG_POLL_TIMEOUT_MS),
  apiTimeoutMs: z.number().default(API_TIMEOUT_MS),
  pollIdleDelayMs: z.number().default(0),
  qrPollIntervalMs: z.number().default(1_000),
  retryDelayMs: z.number().default(2_000),
  backoffDelayMs: z.number().default(30_000),
  maxConsecutiveFailures: z.number().default(3),
  sessionExpiredPauseMs: z.number().default(600_000),
  sendChunkDelayMs: z.number().default(1_500),
  sendChunkRetries: z.number().default(4),
  sendChunkRetryDelayMs: z.number().default(1_000),
  rateLimitCircuitOpenMs: z.number().default(30_000),
  rateLimitCircuitWindowMs: z.number().default(30_000),
  rateLimitCircuitThreshold: z.number().default(1),
  allowCdnHosts: z.array(z.string()).default([...DEFAULT_CDN_ALLOWLIST]),
})

type ResolvedConfig = Required<Config>

/**
 * The iLink gateway service. Register with `ctx.plugin(WechatGateway, config)`;
 * consumers inject `wechat` and subscribe to `wechat/message`.
 */
export class WechatGateway extends Service {
  static Config = Config

  readonly c: ResolvedConfig
  private syncBuf = ''
  private pollTask: Promise<void> | undefined
  private stopPolling = false
  private statusValue: GatewayStatus = 'idle'
  private readonly contextTokens = new Map<string, string>()
  private readonly dedup = new Map<string, number>()
  private readonly typingTickets = new Map<string, { ticket: string; at: number }>()
  private rateLimitHits: number[] = []
  private rateLimitUntil = 0

  constructor(ctx: Context, config: Config) {
    super(ctx, 'wechat')
    this.c = config as ResolvedConfig
    ctx.effect(() => {
      return () => {
        this.stopPolling = true
        void this.stop()
      }
    })
  }

  // -------------------------------------------------------------------------
  // Public service surface
  // -------------------------------------------------------------------------

  /** Current gateway status. */
  get status(): GatewayStatus {
    return this.statusValue
  }

  /** Whether credentials are present (polling is possible). */
  get configured(): boolean {
    return Boolean(this.c.token && this.c.accountId)
  }

  /** The bot account id. */
  get accountId(): string {
    return this.c.accountId
  }

  /** The resolved gateway base url. */
  get baseUrl(): string {
    return this.c.baseUrl
  }

  /** Replace credentials at runtime and restart the poll loop. */
  setCredentials(credentials: { token?: string; accountId?: string; baseUrl?: string }): void {
    if (credentials.token !== undefined) this.c.token = credentials.token
    if (credentials.accountId !== undefined) this.c.accountId = credentials.accountId
    if (credentials.baseUrl !== undefined) this.c.baseUrl = credentials.baseUrl
    void this.restart()
  }

  /** Start (or restart) the poll loop if credentials exist. */
  async start(): Promise<void> {
    if (!this.configured) {
      this.setStatus('idle')
      return
    }
    await this.restart()
  }

  /** Stop the poll loop (idempotent). */
  async stop(): Promise<void> {
    this.stopPolling = true
    const task = this.pollTask
    this.pollTask = undefined
    if (task) {
      try {
        await task
      } catch {
        // loop failures are surfaced through events, not thrown here
      }
    }
    this.setStatus('idle')
  }

  /** Cached context token for a peer, or undefined. */
  contextTokenFor(peerId: string): string | undefined {
    return this.contextTokens.get(peerId)
  }

  /** Record (or replace) the context token a peer supplied. */
  setContextToken(peerId: string, token: string): void {
    if (token) this.contextTokens.set(peerId, token)
  }

  /**
   * Run the QR login flow. The returned credentials are NOT persisted here —
   * the caller (login script / conversation node) stores them through
   * `ctx.credentials`. On success the gateway adopts them and starts polling.
   */
  async loginQr(opts: {
    onQr?: (qr: { value: string; scanData: string; imgContent?: string }) => void
    onStatus?: (status: string) => void
    timeoutMs?: number
  }): Promise<LoginResult> {
    const credentials = await qrLogin({
      baseUrl: this.c.baseUrl,
      timeoutMs: opts.timeoutMs,
      pollIntervalMs: this.c.qrPollIntervalMs,
      onQr: opts.onQr,
      onStatus: (status) => opts.onStatus?.(status),
    })
    if (!credentials) return { success: false, error: 'login failed or timed out' }
    this.setCredentials(credentials)
    return { success: true, credentials }
  }

  /**
   * Send one text message to a peer with per-chunk retry, session-expired
   * tokenless fallback, and a rate-limit circuit breaker. Chunking long
   * content into <= `maxMessageChars` bubbles is the conversation node's job
   * (`../node/outbound.ts`); this method sends exactly one bubble.
   */
  async sendText(to: string, text: string, clientId?: string): Promise<SendResult> {
    if (!text.trim()) return { success: false, error: 'empty message' }
    if (!this.configured) return { success: false, error: 'not configured' }
    let contextToken = this.contextTokens.get(to)
    const id = clientId ?? `dsh-chatnode-${randomId()}`
    let lastError: Error | undefined
    let retriedWithoutToken = false

    for (let attempt = 0; attempt <= this.c.sendChunkRetries; attempt++) {
      if (this.rateLimitUntil > Date.now()) {
        return { success: false, error: `iLink sendmessage rate limited; cooldown active` }
      }
      try {
        const resp = await sendMessage({
          baseUrl: this.c.baseUrl,
          token: this.c.token,
          to,
          text,
          contextToken,
          clientId: id,
          timeoutMs: this.c.apiTimeoutMs,
        })
        const ret = resp.ret
        const errcode = resp.errcode
        if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
          const isSessionExpired = ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE
            || isStaleSessionRet(ret, errcode, resp.errmsg)
          if (isSessionExpired) {
            if (contextToken && !retriedWithoutToken) {
              retriedWithoutToken = true
              contextToken = undefined
              this.contextTokens.delete(to)
              await sleep(this.c.sendChunkRetryDelayMs)
              continue
            }
            lastError = new Error(`iLink sendmessage session expired: ret=${ret} errcode=${errcode}`)
            break
          }
          const isRateLimited = ret === RATE_LIMIT_ERRCODE || errcode === RATE_LIMIT_ERRCODE
          if (isRateLimited) {
            lastError = new Error(`iLink sendmessage rate limited: ret=${ret} errcode=${errcode} errmsg=${resp.errmsg ?? ''}`)
            if (this.recordRateLimit()) break
            if (attempt >= this.c.sendChunkRetries) break
            await sleep(this.c.sendChunkRetryDelayMs * 3)
            continue
          }
          lastError = new Error(`iLink sendmessage error: ret=${ret} errcode=${errcode} errmsg=${resp.errmsg ?? ''}`)
          break
        }
        this.rateLimitHits = []
        return { success: true, messageId: id }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt >= this.c.sendChunkRetries) break
        await sleep(this.c.sendChunkRetryDelayMs * (attempt + 1))
      }
    }
    return { success: false, error: lastError?.message ?? 'send failed' }
  }

  /**
   * Download and decrypt one inbound image item into raw bytes. Uses the
   * gateway's configured CDN base + allowlist so the node layer never touches
   * the wire or the SSRF guard directly.
   * @returns decoded bytes and detected media type, or null when the item
   *   carries no usable media reference.
   */
  async downloadImage(item: WireItem): Promise<{ bytes: Uint8Array; mediaType: RasterImageMediaType } | null> {
    const imageItem = item.image_item
    const media = imageItem?.media
    if (!media) return null
    if (!media.encrypt_query_param && !media.full_url) return null
    const bytes = await downloadMedia({
      cdnBaseUrl: this.c.cdnBaseUrl,
      encryptedQueryParam: media.encrypt_query_param,
      aesKeyBase64: media.aes_key ?? imageItem?.aeskey,
      fullUrl: media.full_url,
      allowHosts: this.c.allowCdnHosts,
      timeoutMs: this.c.apiTimeoutMs,
    })
    return { bytes, mediaType: detectImageMediaType(bytes) ?? 'image/jpeg' }
  }

  /**
   * Send one image file to a peer: AES-encrypt → getuploadurl ticket → upload
   * ciphertext to the CDN → sendmessage with an image item. Uses the peer's
   * cached context_token (the wire REQUIRES it — tokenless sends fail with
   * ret=-2 "prepare failed"), with session-expired and rate-limit handling
   * mirroring {@link sendText}.
   */
  async sendImage(to: string, filePath: string): Promise<SendResult> {
    if (!this.configured) return { success: false, error: 'not configured' }
    let plaintext: Buffer
    try {
      plaintext = await readFile(filePath)
    } catch (error) {
      return { success: false, error: `cannot read image file: ${error instanceof Error ? error.message : String(error)}` }
    }
    const rawsize = plaintext.length
    const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')
    const aesKey = randomBytes(16)
    const aesKeyHex = aesKey.toString('hex')
    const filekey = randomBytes(16).toString('hex')
    const ciphertext = Buffer.from(aes128EcbEncrypt(plaintext, aesKey))

    // 1. CDN upload ticket.
    const ticket = await getUploadUrl({
      baseUrl: this.c.baseUrl,
      token: this.c.token,
      to,
      mediaType: MEDIA_IMAGE,
      filekey,
      rawsize,
      rawfilemd5,
      filesize: ciphertext.length,
      aeskeyHex: aesKeyHex,
      timeoutMs: this.c.apiTimeoutMs,
    })
    const uploadUrl = ticket.uploadFullUrl
      ?? (ticket.uploadParam ? cdnUploadUrl(this.c.cdnBaseUrl, ticket.uploadParam, filekey) : '')
    if (!uploadUrl) return { success: false, error: 'getuploadurl returned neither upload_full_url nor upload_param' }

    // 2. Upload the encrypted payload (POST, PUT fallback on 404).
    let encryptQueryParam: string
    try {
      encryptQueryParam = await uploadCiphertext({ uploadUrl, ciphertext, filekey })
    } catch (error) {
      return { success: false, error: `CDN upload failed: ${error instanceof Error ? error.message : String(error)}` }
    }

    // 3. Send the image message with the same retry/expiry/rate-limit policy as text.
    const aesKeyB64Hex = Buffer.from(aesKeyHex, 'ascii').toString('base64')
    let contextToken = this.contextTokens.get(to)
    const id = `dsh-chatnode-img-${randomId()}`
    let lastError: Error | undefined
    let retriedWithoutToken = false
    for (let attempt = 0; attempt <= this.c.sendChunkRetries; attempt++) {
      if (this.rateLimitUntil > Date.now()) {
        return { success: false, error: 'iLink sendmessage rate limited; cooldown active' }
      }
      try {
        const resp = await sendImageMessage({
          baseUrl: this.c.baseUrl,
          token: this.c.token,
          to,
          encryptQueryParam,
          aesKeyB64Hex,
          ciphertextSize: ciphertext.length,
          contextToken,
          clientId: id,
          timeoutMs: this.c.apiTimeoutMs,
        })
        const ret = resp.ret
        const errcode = resp.errcode
        if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
          const isSessionExpired = ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE
            || isStaleSessionRet(ret, errcode, resp.errmsg)
          if (isSessionExpired) {
            if (contextToken && !retriedWithoutToken) {
              retriedWithoutToken = true
              contextToken = undefined
              this.contextTokens.delete(to)
              await sleep(this.c.sendChunkRetryDelayMs)
              continue
            }
            lastError = new Error(`iLink sendmessage session expired: ret=${ret} errcode=${errcode}`)
            break
          }
          const isRateLimited = ret === RATE_LIMIT_ERRCODE || errcode === RATE_LIMIT_ERRCODE
          if (isRateLimited) {
            lastError = new Error(`iLink sendmessage rate limited: ret=${ret} errcode=${errcode} errmsg=${resp.errmsg ?? ''}`)
            if (this.recordRateLimit()) break
            if (attempt >= this.c.sendChunkRetries) break
            await sleep(this.c.sendChunkRetryDelayMs * 3)
            continue
          }
          lastError = new Error(`iLink sendmessage error: ret=${ret} errcode=${errcode} errmsg=${resp.errmsg ?? ''}`)
          break
        }
        this.rateLimitHits = []
        return { success: true, messageId: id }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt >= this.c.sendChunkRetries) break
        await sleep(this.c.sendChunkRetryDelayMs * (attempt + 1))
      }
    }
    return { success: false, error: lastError?.message ?? 'send image failed' }
  }

  /** Show or hide the typing indicator for a peer (best-effort). */
  async sendTyping(to: string, status: 1 | 2): Promise<void> {
    if (!this.configured) return
    const ticket = await this.typingTicket(to)
    if (!ticket) return
    try {
      await sendTypingRaw({
        baseUrl: this.c.baseUrl,
        token: this.c.token,
        toUserId: to,
        typingTicket: ticket,
        status,
      })
    } catch {
      // typing is cosmetic; never fatal
    }
  }

  /** Fetch (or refresh) the 600s-TTL typing ticket for a peer. */
  private async typingTicket(peerId: string): Promise<string | undefined> {
    const cached = this.typingTickets.get(peerId)
    if (cached && Date.now() - cached.at < 600_000) return cached.ticket
    try {
      const { typingTicket } = await getConfig({
        baseUrl: this.c.baseUrl,
        token: this.c.token,
        userId: peerId,
        contextToken: this.contextTokens.get(peerId),
      })
      if (typingTicket) {
        this.typingTickets.set(peerId, { ticket: typingTicket, at: Date.now() })
        return typingTicket
      }
    } catch {
      // non-fatal
    }
    return undefined
  }

  // -------------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------------

  private async restart(): Promise<void> {
    this.stopPolling = true
    const previous = this.pollTask
    this.pollTask = undefined
    if (previous) {
      try {
        await previous
      } catch {
        // replaced
      }
    }
    if (!this.configured) {
      this.setStatus('idle')
      return
    }
    this.stopPolling = false
    this.setStatus('starting')
    this.pollTask = this.runPollLoop()
  }

  private setStatus(status: GatewayStatus): void {
    if (this.statusValue === status) return
    this.statusValue = status
    this.ctx.emit('wechat/status', status)
  }

  private async runPollLoop(): Promise<void> {
    let consecutiveFailures = 0
    let timeoutMs = this.c.longPollTimeoutMs
    while (!this.stopPolling) {
      try {
        const batch: UpdatesBatch = await getUpdates({
          baseUrl: this.c.baseUrl,
          token: this.c.token,
          syncBuf: this.syncBuf,
          timeoutMs,
        })
        if (this.stopPolling) break

        if (typeof batch.raw.longpolling_timeout_ms === 'number' && batch.raw.longpolling_timeout_ms > 0) {
          timeoutMs = batch.raw.longpolling_timeout_ms
        }

        const ret = batch.raw.ret
        const errcode = batch.raw.errcode
        if ((ret !== undefined && ret !== 0 && ret !== null) || (errcode !== undefined && errcode !== 0 && errcode !== null)) {
          if (ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE
            || isStaleSessionRet(ret, errcode, batch.raw.errmsg)) {
            this.setStatus('paused')
            this.ctx.emit('wechat/error', new Error(`iLink session expired; pausing ${this.c.sessionExpiredPauseMs}ms`))
            await sleep(this.c.sessionExpiredPauseMs)
            consecutiveFailures = 0
            this.setStatus('connected')
            continue
          }
          consecutiveFailures += 1
          const backoff = consecutiveFailures >= this.c.maxConsecutiveFailures
            ? this.c.backoffDelayMs : this.c.retryDelayMs
          this.setStatus(consecutiveFailures >= this.c.maxConsecutiveFailures ? 'reconnecting' : 'connected')
          this.ctx.emit('wechat/error', new Error(
            `getUpdates failed ret=${ret} errcode=${errcode} errmsg=${batch.raw.errmsg ?? ''} (${consecutiveFailures}/${this.c.maxConsecutiveFailures})`,
          ))
          if (consecutiveFailures >= this.c.maxConsecutiveFailures) consecutiveFailures = 0
          await sleep(backoff)
          continue
        }

        consecutiveFailures = 0
        if (batch.syncBuf) this.syncBuf = batch.syncBuf
        this.setStatus('connected')
        for (const message of batch.messages) {
          this.dispatchInbound(message)
        }
        if (this.c.pollIdleDelayMs > 0) await sleep(this.c.pollIdleDelayMs)
      } catch (error) {
        if (this.stopPolling) break
        // HTTP 403 = the iLink exclusive lock: another poller owns this token.
        if (isHttpStatus(error, 403)) {
          this.setStatus('error')
          this.ctx.emit('wechat/fatal', new Error(
            'iLink returned HTTP 403: another poller (hermes-agent, OpenClaw, or a duplicate dsh-chatnode-wechat) is already polling this WeChat account. ' +
            'iLink allows exactly one authenticated poller per token. Stop the other gateway or use a dedicated WeChat account.',
          ))
          this.stopPolling = true
          break
        }
        consecutiveFailures += 1
        const backoff = consecutiveFailures >= this.c.maxConsecutiveFailures
          ? this.c.backoffDelayMs : this.c.retryDelayMs
        this.setStatus(consecutiveFailures >= this.c.maxConsecutiveFailures ? 'reconnecting' : 'connected')
        this.ctx.emit('wechat/error', error instanceof Error ? error : new Error(String(error)))
        if (consecutiveFailures >= this.c.maxConsecutiveFailures) consecutiveFailures = 0
        await sleep(backoff)
      }
    }
    // A fatal error keeps its terminal status; an ordinary stop returns to idle.
    if (this.statusValue !== 'error') this.setStatus('idle')
  }

  // -------------------------------------------------------------------------
  // Inbound pipeline (dedup + context token capture; policy is the node's job)
  // -------------------------------------------------------------------------

  private dispatchInbound(message: InboundMessage): void {
    const sender = String(message.from_user_id ?? '')
    const messageId = String(message.message_id ?? '')
    if (!sender || sender === this.c.accountId) return
    if (messageId && this.isDuplicate(messageId)) return
    if (messageId) this.remember(messageId)

    const contextToken = String(message.context_token ?? '')
    if (contextToken) this.contextTokens.set(sender, contextToken)

    this.ctx.emit('wechat/message', message)
  }

  private isDuplicate(id: string): boolean {
    const seen = this.dedup.get(id)
    if (seen !== undefined && Date.now() - seen < MESSAGE_DEDUP_TTL_SECONDS * 1000) return true
    return false
  }

  private remember(id: string): void {
    this.dedup.set(id, Date.now())
    // bounded sweep: drop entries older than the TTL
    if (this.dedup.size > 512) {
      const cutoff = Date.now() - MESSAGE_DEDUP_TTL_SECONDS * 1000
      for (const [key, at] of this.dedup) {
        if (at < cutoff) this.dedup.delete(key)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rate-limit circuit
  // -------------------------------------------------------------------------

  private recordRateLimit(): boolean {
    const now = Date.now()
    const windowStart = now - this.c.rateLimitCircuitWindowMs
    this.rateLimitHits = this.rateLimitHits.filter((ts) => ts >= windowStart)
    this.rateLimitHits.push(now)
    if (this.rateLimitHits.length >= this.c.rateLimitCircuitThreshold) {
      this.rateLimitUntil = Math.max(this.rateLimitUntil, now + this.c.rateLimitCircuitOpenMs)
      return this.rateLimitUntil > now
    }
    return false
  }
}

function isHttpStatus(error: unknown, status: number): boolean {
  return error instanceof Error && /HTTP 403/.test(error.message)
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export default WechatGateway
