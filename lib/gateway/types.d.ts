/**
 * iLink wire protocol constants and schemas.
 *
 * Reconstructed from the hermes-agent native WeChat channel
 * (`gateway/platforms/weixin.py`, MIT) and verified against recorded
 * transcripts in `test/fixtures/`. Tencent publishes no docs for this
 * gateway — treat every field as best-effort and re-record fixtures before
 * refactors (see README "Protocol opacity").
 *
 * @module @dsh-cowork/chatnode-wechat/gateway/types
 */
/** Primary iLink gateway host. */
export declare const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
/** CDN used for encrypted media transfer. */
export declare const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
/** Static app identity the bot gateway expects. */
export declare const ILINK_APP_ID = "bot";
/** Channel version reported inside `base_info`. */
export declare const CHANNEL_VERSION = "2.2.0";
/** `iLink-App-ClientVersion` — (2 << 16) | (2 << 8) | 0. */
export declare const ILINK_APP_CLIENT_VERSION: number;
export declare const EP_GET_UPDATES = "ilink/bot/getupdates";
export declare const EP_SEND_MESSAGE = "ilink/bot/sendmessage";
export declare const EP_SEND_TYPING = "ilink/bot/sendtyping";
export declare const EP_GET_CONFIG = "ilink/bot/getconfig";
export declare const EP_GET_UPLOAD_URL = "ilink/bot/getuploadurl";
export declare const EP_GET_BOT_QR = "ilink/bot/get_bot_qrcode";
export declare const EP_GET_QR_STATUS = "ilink/bot/get_qrcode_status";
/** Long-poll window for getUpdates (server may suggest a different value). */
export declare const LONG_POLL_TIMEOUT_MS = 35000;
export declare const API_TIMEOUT_MS = 15000;
export declare const CONFIG_TIMEOUT_MS = 10000;
export declare const QR_TIMEOUT_MS = 35000;
/** WeChat client-level cap for one text bubble; outbound chunks must fit. */
export declare const MAX_MESSAGE_CHARS = 2000;
/** item_list item kinds. */
export declare const ITEM_TEXT = 1;
export declare const ITEM_IMAGE = 2;
export declare const ITEM_VOICE = 3;
export declare const ITEM_FILE = 4;
export declare const ITEM_VIDEO = 5;
/** Media type ids for getuploadurl (mirrors hermes MEDIA_*). */
export declare const MEDIA_IMAGE = 1;
export declare const MSG_TYPE_USER = 1;
export declare const MSG_TYPE_BOT = 2;
export declare const MSG_STATE_FINISH = 2;
export declare const TYPING_START = 1;
export declare const TYPING_STOP = 2;
/** iLink session-expired error code (both `ret` and `errcode` slots). */
export declare const SESSION_EXPIRED_ERRCODE = -14;
/**
 * iLink frequency-limit error code. `ret`/`errcode` -2 with errmsg
 * "unknown error" is a STALE-SESSION signal instead (see
 * {@link isStaleSessionRet}).
 */
export declare const RATE_LIMIT_ERRCODE = -2;
/** Dedup TTL for inbound message ids (seconds). */
export declare const MESSAGE_DEDUP_TTL_SECONDS = 300;
/** Whether an iLink error tuple means the session went stale, not rate-limited. */
export declare function isStaleSessionRet(ret: number | undefined, errcode: number | undefined, errmsg: string | undefined): boolean;
/** A media reference inside an item (CDN query param + AES key). */
export interface WireMedia {
    encrypt_query_param?: string;
    aes_key?: string;
    full_url?: string;
    [key: string]: unknown;
}
/** One element of an inbound message's `item_list`. */
export interface WireItem {
    type?: number;
    text_item?: {
        text?: string;
    };
    voice_item?: {
        text?: string;
        media?: WireMedia;
    };
    image_item?: {
        media?: WireMedia;
        aeskey?: string;
    };
    video_item?: {
        media?: WireMedia;
    };
    file_item?: {
        file_name?: string;
        media?: WireMedia;
    };
    ref_msg?: {
        title?: string;
        message_item?: unknown;
    };
    [key: string]: unknown;
}
/** One inbound iLink message as delivered by getUpdates. */
export interface InboundMessage {
    from_user_id?: string;
    to_user_id?: string;
    message_id?: string;
    msg_type?: number;
    context_token?: string;
    room_id?: string;
    chat_room_id?: string;
    item_list?: WireItem[];
    [key: string]: unknown;
}
/** getUpdates response envelope. */
export interface GetUpdatesResponse {
    ret?: number;
    errcode?: number;
    errmsg?: string;
    get_updates_buf?: string;
    longpolling_timeout_ms?: number;
    msgs?: InboundMessage[];
    [key: string]: unknown;
}
/** sendmessage response envelope. */
export interface SendMessageResponse {
    ret?: number;
    errcode?: number;
    errmsg?: string;
    [key: string]: unknown;
}
/** get_bot_qrcode response. */
export interface QrCodeResponse {
    qrcode?: string;
    qrcode_img_content?: string;
    [key: string]: unknown;
}
/** get_qrcode_status response. */
export interface QrStatusResponse {
    status?: string;
    redirect_host?: string;
    ilink_bot_id?: string;
    bot_token?: string;
    baseurl?: string;
    ilink_user_id?: string;
    [key: string]: unknown;
}
/** getconfig response (typing ticket). */
export interface GetConfigResponse {
    typing_ticket?: string;
    [key: string]: unknown;
}
/** Credentials produced by a successful QR login. */
export interface WechatCredentials {
    /** iLink bot account id (also the poller's own `from_user_id`). */
    accountId: string;
    /** Bearer token for the bot session. */
    token: string;
    /** Gateway base url (may be redirected to a regional host). */
    baseUrl: string;
    /** The bot's own ilink user id when the server reports one. */
    userId?: string;
}
/** QR login lifecycle statuses surfaced to a caller. */
export type QrLoginStatus = 'wait' | 'scaned' | 'scaned_but_redirect' | 'expired' | 'confirmed';
//# sourceMappingURL=types.d.ts.map