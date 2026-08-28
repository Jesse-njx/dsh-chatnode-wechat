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
/** CDN hosts the client is allowed to fetch media from (SSRF guard). */
export declare const DEFAULT_CDN_ALLOWLIST: readonly string[];
/** PKCS#7 pad a plaintext to a full AES block. */
export declare function pkcs7Pad(data: Uint8Array, blockSize?: number): Uint8Array;
/** Strip a valid PKCS#7 pad; returns the input unchanged when the pad is malformed. */
export declare function pkcs7Unpad(data: Uint8Array): Uint8Array;
/** AES-128-ECB encrypt (used by fixtures and the fake server). */
export declare function aes128EcbEncrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array;
/** AES-128-ECB decrypt with PKCS#7 unpad. */
export declare function aes128EcbDecrypt(ciphertext: Uint8Array, key: Uint8Array): Uint8Array;
/**
 * Parse an iLink `aes_key`. Accepts base64 of 16 raw bytes, or base64 of a
 * 32-char hex string (the wire sometimes hex-encodes then base64-encodes).
 * @throws when the decoded form matches neither shape.
 */
export declare function parseAesKey(aesKeyBase64: string): Uint8Array;
/** Build the CDN download URL for an encrypted media reference. */
export declare function cdnDownloadUrl(cdnBaseUrl: string, encryptedQueryParam: string): string;
/** Build the CDN upload URL from a getuploadurl `upload_param` + filekey. */
export declare function cdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string;
/**
 * Assert a media URL points at a known WeChat CDN host over http(s).
 * @throws on anything else (SSRF guard, mirrors hermes-agent's allowlist).
 */
export declare function assertWeixinCdnUrl(url: string, allow?: readonly string[]): void;
/**
 * Download one media item's bytes and decrypt them.
 *
 * @param fetchImpl - injectable fetch (defaults to global fetch) for tests.
 * @throws when the item has no usable URL, the host is not allowlisted, or the
 *   download/decrypt fails.
 */
export declare function downloadMedia(opts: {
    cdnBaseUrl?: string;
    encryptedQueryParam?: string;
    aesKeyBase64?: string;
    fullUrl?: string;
    allowHosts?: readonly string[];
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}): Promise<Uint8Array>;
/** Best-effort mime guess from a file name. */
export declare function mimeFromFilename(filename: string): string;
/** Raster image media types we can hand to the model's vision path. */
export type RasterImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
/**
 * Detect a raster image's media type from its magic bytes. WeChat CDN images
 * are usually JPEG, but PNG/WebP/GIF also occur; the type drives both the
 * on-disk extension and the vision tool's decoding.
 */
export declare function detectImageMediaType(bytes: Uint8Array): RasterImageMediaType | null;
/** File extension for a detected raster image media type (no leading dot). */
export declare function imageExt(mediaType: RasterImageMediaType): string;
//# sourceMappingURL=media.d.ts.map