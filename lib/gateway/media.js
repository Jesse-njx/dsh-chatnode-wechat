/**
 * WeChat CDN media download + AES-128-ECB decryption.
 *
 * iLink delivers image/video/file/voice items as an encrypted CDN reference:
 * `encrypt_query_param` (or `full_url`) plus an `aes_key`. The key travels
 * base64-encoded and may be either 16 raw bytes or a 32-char hex string.
 * Decryption is AES-128-ECB with PKCS#7 padding, per the hermes-agent
 * reference implementation.
 *
 * @module @dsh-cowork/chatnode-wechat/gateway/media
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { WEIXIN_CDN_BASE_URL } from "./types.js";
/** CDN hosts the client is allowed to fetch media from (SSRF guard). */
export const DEFAULT_CDN_ALLOWLIST = [
    'novac2c.cdn.weixin.qq.com',
    'ilinkai.weixin.qq.com',
    'wx.qlogo.cn',
    'thirdwx.qlogo.cn',
    'res.wx.qq.com',
    'mmbiz.qpic.cn',
    'mmbiz.qlogo.cn',
];
/** PKCS#7 pad a plaintext to a full AES block. */
export function pkcs7Pad(data, blockSize = 16) {
    const padLen = blockSize - (data.length % blockSize);
    const out = new Uint8Array(data.length + padLen);
    out.set(data);
    out.fill(padLen, data.length);
    return out;
}
/** Strip a valid PKCS#7 pad; returns the input unchanged when the pad is malformed. */
export function pkcs7Unpad(data) {
    if (data.length === 0)
        return data;
    const last = data[data.length - 1];
    if (last === undefined)
        return data;
    if (last >= 1 && last <= 16 && data.length >= last) {
        let valid = true;
        for (let i = data.length - last; i < data.length; i++) {
            if (data[i] !== last) {
                valid = false;
                break;
            }
        }
        if (valid)
            return data.subarray(0, data.length - last);
    }
    return data;
}
/** AES-128-ECB encrypt (used by fixtures and the fake server). */
export function aes128EcbEncrypt(plaintext, key) {
    const cipher = createCipheriv('aes-128-ecb', key, null);
    // Node's Cipheriv.update accepts Uint8Array; typing is Buffer-typed upstream.
    const padded = pkcs7Pad(plaintext);
    return Buffer.concat([Buffer.from(cipher.update(padded)), Buffer.from(cipher.final())]);
}
/** AES-128-ECB decrypt with PKCS#7 unpad. */
export function aes128EcbDecrypt(ciphertext, key) {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    const out = Buffer.concat([Buffer.from(decipher.update(ciphertext)), Buffer.from(decipher.final())]);
    return pkcs7Unpad(out);
}
/**
 * Parse an iLink `aes_key`. Accepts base64 of 16 raw bytes, or base64 of a
 * 32-char hex string (the wire sometimes hex-encodes then base64-encodes).
 * @throws when the decoded form matches neither shape.
 */
export function parseAesKey(aesKeyBase64) {
    const decoded = Buffer.from(aesKeyBase64, 'base64');
    if (decoded.length === 16)
        return decoded;
    if (decoded.length === 32) {
        const text = decoded.toString('ascii');
        if (text && /^[0-9a-fA-F]{32}$/.test(text))
            return Buffer.from(text, 'hex');
    }
    throw new Error(`unexpected aes_key format (${decoded.length} decoded bytes)`);
}
/** Build the CDN download URL for an encrypted media reference. */
export function cdnDownloadUrl(cdnBaseUrl, encryptedQueryParam) {
    return `${cdnBaseUrl.replace(/\/+$/, '')}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}
/** Build the CDN upload URL from a getuploadurl `upload_param` + filekey. */
export function cdnUploadUrl(cdnBaseUrl, uploadParam, filekey) {
    return `${cdnBaseUrl.replace(/\/+$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}
/**
 * Assert a media URL points at a known WeChat CDN host over http(s).
 * @throws on anything else (SSRF guard, mirrors hermes-agent's allowlist).
 */
export function assertWeixinCdnUrl(url, allow = DEFAULT_CDN_ALLOWLIST) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        throw new Error(`Unparseable media URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Media URL has disallowed scheme ${parsed.protocol}; only http/https are permitted.`);
    }
    if (!allow.includes(parsed.hostname)) {
        throw new Error(`Media URL host ${parsed.hostname} is not in the WeChat CDN allowlist. Refusing to fetch to prevent SSRF.`);
    }
}
/**
 * Download one media item's bytes and decrypt them.
 *
 * @param fetchImpl - injectable fetch (defaults to global fetch) for tests.
 * @throws when the item has no usable URL, the host is not allowlisted, or the
 *   download/decrypt fails.
 */
export async function downloadMedia(opts) {
    const { cdnBaseUrl = WEIXIN_CDN_BASE_URL, encryptedQueryParam, aesKeyBase64, fullUrl, allowHosts, timeoutMs = 60_000, fetchImpl = fetch, } = opts;
    let url;
    if (encryptedQueryParam) {
        url = cdnDownloadUrl(cdnBaseUrl, encryptedQueryParam);
    }
    else if (fullUrl) {
        url = fullUrl;
    }
    else {
        throw new Error('media item had neither encrypt_query_param nor full_url');
    }
    assertWeixinCdnUrl(url, allowHosts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, { signal: controller.signal });
        if (!response.ok)
            throw new Error(`media download HTTP ${response.status}`);
        const raw = new Uint8Array(await response.arrayBuffer());
        if (aesKeyBase64)
            return aes128EcbDecrypt(raw, parseAesKey(aesKeyBase64));
        return raw;
    }
    finally {
        clearTimeout(timer);
    }
}
/** Best-effort mime guess from a file name. */
export function mimeFromFilename(filename) {
    const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
    const table = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
        mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
        mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', silk: 'audio/silk',
        pdf: 'application/pdf', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    return table[ext] ?? 'application/octet-stream';
}
/**
 * Detect a raster image's media type from its magic bytes. WeChat CDN images
 * are usually JPEG, but PNG/WebP/GIF also occur; the type drives both the
 * on-disk extension and the vision tool's decoding.
 */
export function detectImageMediaType(bytes) {
    const b = bytes;
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        return 'image/jpeg';
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
        return 'image/png';
    if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
        return 'image/gif';
    if (b.length >= 12 &&
        b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // "WEBP"
    )
        return 'image/webp';
    return null;
}
/** File extension for a detected raster image media type (no leading dot). */
export function imageExt(mediaType) {
    switch (mediaType) {
        case 'image/jpeg': return 'jpg';
        case 'image/png': return 'png';
        case 'image/webp': return 'webp';
        case 'image/gif': return 'gif';
    }
}
//# sourceMappingURL=media.js.map