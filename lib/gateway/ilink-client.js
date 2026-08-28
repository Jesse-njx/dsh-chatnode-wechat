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
import { randomBytes } from 'node:crypto';
import { API_TIMEOUT_MS, CHANNEL_VERSION, CONFIG_TIMEOUT_MS, EP_GET_BOT_QR, EP_GET_CONFIG, EP_GET_QR_STATUS, EP_GET_UPDATES, EP_GET_UPLOAD_URL, EP_SEND_MESSAGE, EP_SEND_TYPING, ILINK_APP_CLIENT_VERSION, ILINK_APP_ID, ILINK_BASE_URL, LONG_POLL_TIMEOUT_MS, MSG_STATE_FINISH, MSG_TYPE_BOT, QR_TIMEOUT_MS, ITEM_TEXT, ITEM_IMAGE, } from "./types.js";
/** A structured transport failure carrying the raw response when present. */
export class IlinkError extends Error {
    ret;
    errcode;
    raw;
    constructor(message, opts = {}) {
        super(message);
        this.name = 'IlinkError';
        this.ret = opts.ret;
        this.errcode = opts.errcode;
        this.raw = opts.raw;
    }
}
/** Headers every iLink request carries. */
function requestHeaders(token, body) {
    const uin = randomBytes(4).toString('base64url');
    const headers = {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'Content-Length': String(Buffer.byteLength(body)),
        'X-WECHAT-UIN': uin,
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    };
    if (token)
        headers.Authorization = `Bearer ${token}`;
    return headers;
}
function baseInfo() {
    return { channel_version: CHANNEL_VERSION };
}
/** POST one JSON envelope and parse the response object. */
export async function postJson(opts) {
    const { baseUrl = ILINK_BASE_URL, endpoint, payload, token, timeoutMs = API_TIMEOUT_MS, fetchImpl = fetch, } = opts;
    const body = JSON.stringify({ ...payload, base_info: baseInfo() });
    const url = `${baseUrl.replace(/\/+$/, '')}/${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: requestHeaders(token, body),
            body,
            signal: controller.signal,
        });
        const raw = await response.text();
        if (!response.ok) {
            // 403 is the iLink exclusive-lock symptom: a second poller is active on
            // the same token (hermes-agent / OpenClaw coexistence). Surface it loudly.
            throw new IlinkError(`iLink POST ${endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`, { raw });
        }
        return JSON.parse(raw);
    }
    finally {
        clearTimeout(timer);
    }
}
/** GET one endpoint (QR endpoints are tokenless GETs). */
export async function getJson(opts) {
    const { baseUrl = ILINK_BASE_URL, endpoint, timeoutMs = QR_TIMEOUT_MS, fetchImpl = fetch, } = opts;
    const url = `${baseUrl.replace(/\/+$/, '')}/${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, {
            method: 'GET',
            headers: {
                'iLink-App-Id': ILINK_APP_ID,
                'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
            },
            signal: controller.signal,
        });
        const raw = await response.text();
        if (!response.ok)
            throw new IlinkError(`iLink GET ${endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`, { raw });
        return JSON.parse(raw);
    }
    finally {
        clearTimeout(timer);
    }
}
/** Long-poll getUpdates; a timeout returns an empty batch (not an error). */
export async function getUpdates(opts) {
    const { baseUrl, token, syncBuf, timeoutMs = LONG_POLL_TIMEOUT_MS, fetchImpl } = opts;
    try {
        const raw = await postJson({
            baseUrl,
            endpoint: EP_GET_UPDATES,
            payload: { get_updates_buf: syncBuf },
            token,
            timeoutMs,
            fetchImpl,
        });
        return {
            messages: Array.isArray(raw.msgs) ? raw.msgs : [],
            syncBuf: raw.get_updates_buf ?? syncBuf,
            suggestedTimeoutMs: raw.longpolling_timeout_ms,
            raw,
        };
    }
    catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
            return { messages: [], syncBuf, raw: { ret: 0, msgs: [] } };
        }
        throw error;
    }
}
/** Send one text message to a peer. */
export async function sendMessage(opts) {
    const { baseUrl, token, to, text, contextToken, clientId, timeoutMs, fetchImpl } = opts;
    if (!text.trim())
        throw new Error('sendMessage: text must not be empty');
    const msg = {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: ITEM_TEXT, text_item: { text } }],
    };
    if (contextToken)
        msg.context_token = contextToken;
    return postJson({
        baseUrl,
        endpoint: EP_SEND_MESSAGE,
        payload: { msg },
        token,
        timeoutMs,
        fetchImpl,
    });
}
/** Request a CDN upload ticket for one media file. */
export async function getUploadUrl(opts) {
    const { baseUrl, token, to, mediaType, filekey, rawsize, rawfilemd5, filesize, aeskeyHex, timeoutMs, fetchImpl } = opts;
    const raw = await postJson({
        baseUrl,
        endpoint: EP_GET_UPLOAD_URL,
        payload: {
            filekey,
            media_type: mediaType,
            to_user_id: to,
            rawsize,
            rawfilemd5,
            filesize,
            no_need_thumb: true,
            aeskey: aeskeyHex,
        },
        token,
        timeoutMs,
        fetchImpl,
    });
    return { uploadParam: raw.upload_param, uploadFullUrl: raw.upload_full_url };
}
/**
 * Upload encrypted media bytes to the WeChat CDN.
 * POST first; a 404 falls back to PUT (the CDN changed its method at some
 * point). The download key is returned in the `x-encrypted-param` response
 * header; when the header is missing the filekey itself is the key (per the
 * hermes-agent reference).
 */
export async function uploadCiphertext(opts) {
    const { uploadUrl, ciphertext, filekey, timeoutMs = 120_000, fetchImpl = fetch } = opts;
    for (const method of ['POST', 'PUT']) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(uploadUrl, {
                method,
                headers: { 'Content-Type': 'application/octet-stream' },
                body: Buffer.from(ciphertext),
                signal: controller.signal,
            });
            if (response.status === 404 && method === 'POST')
                continue;
            if (!response.ok)
                throw new Error(`CDN upload HTTP ${response.status}`);
            const param = response.headers.get('x-encrypted-param');
            return param && param.trim() ? param : filekey;
        }
        finally {
            clearTimeout(timer);
        }
    }
    throw new Error('CDN upload failed with both POST and PUT');
}
/** Send one image-item message to a peer. */
export async function sendImageMessage(opts) {
    const { baseUrl, token, to, encryptQueryParam, aesKeyB64Hex, ciphertextSize, contextToken, clientId, timeoutMs, fetchImpl, } = opts;
    const msg = {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{
                type: ITEM_IMAGE,
                image_item: {
                    media: {
                        encrypt_query_param: encryptQueryParam,
                        aes_key: aesKeyB64Hex,
                        encrypt_type: 1,
                    },
                    mid_size: ciphertextSize,
                },
            }],
    };
    if (contextToken)
        msg.context_token = contextToken;
    return postJson({
        baseUrl,
        endpoint: EP_SEND_MESSAGE,
        payload: { msg },
        token,
        timeoutMs,
        fetchImpl,
    });
}
/** Fetch the per-peer typing ticket (600s TTL) used by sendTyping. */
export async function getConfig(opts) {
    const { baseUrl, token, userId, contextToken, fetchImpl } = opts;
    const payload = { ilink_user_id: userId };
    if (contextToken)
        payload.context_token = contextToken;
    const raw = await postJson({
        baseUrl,
        endpoint: EP_GET_CONFIG,
        payload,
        token,
        timeoutMs: CONFIG_TIMEOUT_MS,
        fetchImpl,
    });
    return { typingTicket: raw.typing_ticket };
}
/** Start (1) or stop (2) the typing indicator for a peer. */
export async function sendTyping(opts) {
    const { baseUrl, token, toUserId, typingTicket, status, fetchImpl } = opts;
    await postJson({
        baseUrl,
        endpoint: EP_SEND_TYPING,
        payload: { ilink_user_id: toUserId, typing_ticket: typingTicket, status },
        token,
        timeoutMs: CONFIG_TIMEOUT_MS,
        fetchImpl,
    });
}
/** Fetch the QR login material (bot_type=3 = personal-account bot). */
export async function getBotQrcode(opts) {
    const { baseUrl, botType = '3', fetchImpl } = opts;
    return getJson({
        baseUrl,
        endpoint: `${EP_GET_BOT_QR}?bot_type=${botType}`,
        fetchImpl,
    });
}
/** Poll the QR login status. */
export async function getQrcodeStatus(opts) {
    const { baseUrl, qrcode, fetchImpl } = opts;
    return getJson({
        baseUrl,
        endpoint: `${EP_GET_QR_STATUS}?qrcode=${encodeURIComponent(qrcode)}`,
        fetchImpl,
    });
}
/**
 * Run the interactive QR login flow: fetch a QR, poll its status until
 * `confirmed`, and resolve credentials. Callbacks let a caller render the QR
 * (URL/ASCII) and observe status transitions (scan, redirect, expiry).
 *
 * @returns credentials, or `null` when login failed or timed out.
 */
export async function qrLogin(opts) {
    const { baseUrl, timeoutMs = 480_000, pollIntervalMs = 1000, onQr, onStatus, fetchImpl } = opts;
    const deadline = Date.now() + timeoutMs;
    let currentBaseUrl = baseUrl ?? ILINK_BASE_URL;
    let qrcodeValue = '';
    let qrcodeImg = '';
    // Fetch the initial QR (with one retry for transient failures).
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const qr = await getBotQrcode({ baseUrl: currentBaseUrl, fetchImpl });
            qrcodeValue = qr.qrcode ?? '';
            qrcodeImg = qr.qrcode_img_content ?? '';
            break;
        }
        catch {
            if (attempt === 1)
                return null;
        }
    }
    if (!qrcodeValue)
        return null;
    // WeChat scans the full liteapp URL; the raw value is the hex token used for
    // status polling.
    const scanData = qrcodeImg || qrcodeValue;
    onQr?.({ value: qrcodeValue, scanData, imgContent: qrcodeImg });
    let refreshCount = 0;
    while (Date.now() < deadline) {
        let status;
        try {
            status = await getQrcodeStatus({ baseUrl: currentBaseUrl, qrcode: qrcodeValue, fetchImpl });
        }
        catch {
            await sleep(pollIntervalMs);
            continue;
        }
        const state = status.status ?? 'wait';
        onStatus?.(state, status);
        if (state === 'scaned_but_redirect' && status.redirect_host) {
            currentBaseUrl = `https://${status.redirect_host}`;
        }
        else if (state === 'expired') {
            refreshCount += 1;
            if (refreshCount > 3)
                return null;
            const qr = await getBotQrcode({ baseUrl: currentBaseUrl, fetchImpl }).catch(() => null);
            if (!qr || !qr.qrcode)
                return null;
            qrcodeValue = qr.qrcode;
            qrcodeImg = qr.qrcode_img_content ?? '';
            onQr?.({ value: qrcodeValue, scanData: qrcodeImg || qrcodeValue, imgContent: qrcodeImg });
        }
        else if (state === 'confirmed') {
            const accountId = status.ilink_bot_id ?? '';
            const token = status.bot_token ?? '';
            if (!accountId || !token)
                return null;
            return {
                accountId,
                token,
                baseUrl: status.baseurl ?? currentBaseUrl,
                userId: status.ilink_user_id,
            };
        }
        await sleep(pollIntervalMs);
    }
    return null;
}
/** Cancel-safe sleep helper. */
export function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted)
            return resolve();
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}
//# sourceMappingURL=ilink-client.js.map