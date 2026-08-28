/**
 * dsh-chatnode-wechat — one DSH bundle, two separable Cordis plugins.
 *
 * The bundle default export is a composite plugin that mounts:
 *
 * 1. **wechat-gateway** (`WechatGateway`) — the iLink gateway as the `wechat`
 *    service: QR login, authenticated long-poll, reconnect/backoff, send
 *    retry + rate-limit circuit, typing indicator, CDN media download.
 * 2. **wechat-conversation-node** (`wechatConversationNode`) — the WeChat ⇄
 *    DSH conversation bridge: allowlist gate, session targeting, commands,
 *    digest outbound, approvals.
 *
 * Both plugins are exported by name so tests (and advanced users) can mount
 * them separately. Install the bundle with `dsh plugin add
 * @dsh-cowork/chatnode-wechat` and configure via the profile patch
 * (`plugins.dsh-chatnode-wechat`); credentials live in dsh credentials, never
 * in the patch file.
 *
 * @module @dsh-cowork/chatnode-wechat
 */
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { API_TIMEOUT_MS, ILINK_BASE_URL, LONG_POLL_TIMEOUT_MS, WEIXIN_CDN_BASE_URL, } from "./gateway/types.js";
import { DEFAULT_CDN_ALLOWLIST } from "./gateway/media.js";
import { WechatGateway } from "./gateway/index.js";
import { wechatConversationNode } from "./node/index.js";
export { WechatGateway, Config as GatewayConfig } from "./gateway/index.js";
export { wechatConversationNode, WechatConversationNode, Config as NodeConfig, } from "./node/index.js";
export * from "./gateway/types.js";
export { downloadMedia, parseAesKey, aes128EcbDecrypt } from "./gateway/media.js";
export { splitForWechat, digestLine, textOfAssistantMessage } from "./node/outbound.js";
export { extractText, isGroupMessage } from "./node/inbound.js";
export { listSessions } from "./node/commands.js";
/** Cordis plugin name used by loader diagnostics and profile config. */
export const name = 'dsh-chatnode-wechat';
/** Services the bundle needs (provided by dsh-base). */
export const inject = ['sessions', 'agents', 'approval', 'credentials', 'sessionTitle'];
export const Config = z.object({
    allowFrom: z.array(z.string()).default([]),
    digestIntervalSec: z.number().default(300),
    approvalTimeoutSec: z.number().default(600),
    maxMessageChars: z.number().default(2000),
    sendChunkDelayMs: z.number().default(1_500),
    cwd: z.string(),
    agentPreset: z.string(),
    agentProvider: z.string(),
    agentModel: z.string(),
    baseUrl: z.string().default(ILINK_BASE_URL),
    cdnBaseUrl: z.string().default(WEIXIN_CDN_BASE_URL),
    token: z.string().default(''),
    accountId: z.string().default(''),
    longPollTimeoutMs: z.number().default(LONG_POLL_TIMEOUT_MS),
    apiTimeoutMs: z.number().default(API_TIMEOUT_MS),
    retryDelayMs: z.number().default(2_000),
    backoffDelayMs: z.number().default(30_000),
    maxConsecutiveFailures: z.number().default(3),
    sessionExpiredPauseMs: z.number().default(600_000),
    sendChunkRetries: z.number().default(4),
    sendChunkRetryDelayMs: z.number().default(1_000),
    rateLimitCircuitOpenMs: z.number().default(30_000),
    rateLimitCircuitWindowMs: z.number().default(30_000),
    rateLimitCircuitThreshold: z.number().default(1),
    allowCdnHosts: z.array(z.string()).default([...DEFAULT_CDN_ALLOWLIST]),
});
/**
 * Mount both plugins. The gateway starts polling only when credentials are
 * present (resolved from the `credentials` service at startup).
 *
 * Cordis scoping note: services mounted via `ctx.plugin()` from this apply
 * context are visible to child contexts (the conversation node resolves
 * `wechat` fine) but NOT to a direct property access on the apply context
 * itself, so the credentials boot runs inside an injected child scope.
 */
export function apply(ctx, config) {
    const gatewayConfig = extractGatewayConfig(config);
    ctx.plugin(WechatGateway, gatewayConfig);
    ctx.plugin(wechatConversationNode, {
        allowFrom: config.allowFrom ?? [],
        digestIntervalSec: config.digestIntervalSec,
        approvalTimeoutSec: config.approvalTimeoutSec,
        maxMessageChars: config.maxMessageChars,
        sendChunkDelayMs: config.sendChunkDelayMs,
        cwd: config.cwd,
        agentPreset: config.agentPreset,
        agentProvider: config.agentProvider,
        agentModel: config.agentModel,
    });
    // Credentials go through the dsh credentials service — never in the patch
    // file. Resolve them at boot and start polling only when they exist.
    ctx.inject(['wechat', 'credentials'], (bootCtx) => {
        void bootWithCredentials(bootCtx, config);
    });
}
/**
 * Resolve WEIXIN_* credentials from `ctx.credentials` and start the gateway.
 * Without credentials the gateway stays idle; run `pnpm login` (the
 * CLI-driven QR flow) to pair a WeChat account.
 */
async function bootWithCredentials(ctx, config) {
    try {
        const token = await ctx.credentials.resolve(credentialRef('WEIXIN_BOT_TOKEN'));
        const accountId = await ctx.credentials.resolve(credentialRef('WEIXIN_ACCOUNT_ID'));
        const baseUrl = await ctx.credentials.resolve(credentialRef('WEIXIN_BASE_URL'));
        if (token?.value && accountId?.value) {
            ctx.wechat.setCredentials({
                token: token.value,
                accountId: accountId.value,
                baseUrl: baseUrl?.value || config.baseUrl,
            });
        }
    }
    catch (error) {
        ctx.logger?.warn?.('[dsh-chatnode-wechat] credentials resolution failed: %s', error instanceof Error ? error.message : error);
    }
    await ctx.wechat.start();
    if (!ctx.wechat.configured) {
        ctx.logger?.info?.('[dsh-chatnode-wechat] no WEIXIN_BOT_TOKEN/WEIXIN_ACCOUNT_ID credentials — gateway idle. ' +
            'Run the QR login script (packages/chatnode-wechat: `pnpm login`) to pair a WeChat account.');
    }
}
function extractGatewayConfig(config) {
    const out = {};
    if (config.baseUrl !== undefined)
        out.baseUrl = config.baseUrl;
    if (config.cdnBaseUrl !== undefined)
        out.cdnBaseUrl = config.cdnBaseUrl;
    if (config.token !== undefined)
        out.token = config.token;
    if (config.accountId !== undefined)
        out.accountId = config.accountId;
    return out;
}
export default { name, inject, Config, apply };
//# sourceMappingURL=index.js.map