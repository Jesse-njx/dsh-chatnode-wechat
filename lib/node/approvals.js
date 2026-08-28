/**
 * Permission-request bridge: DSH `approval/request` → WeChat text prompt.
 *
 * WeChat personal accounts have no buttons, so a permission request is
 * rendered as a numbered text prompt and resolved by `/yes` or `/no` (bare
 * `1`/`2` also work while exactly one request is pending). A reply timeout
 * falls back to DSH's default deny (`'rejected'`), matching the spec:
 * timeout → deny.
 *
 * The bridge only answers for agents the conversation node drives (the
 * active session); every other request delegates via `next()`.
 *
 * @module @dsh-cowork/chatnode-wechat/node/approvals
 */
import { sendTextToPeer } from "./outbound.js";
import { sessionBadge } from "./labels.js";
/** Attach the `approval/request` answerer. Returns a disposer. */
export function attachApprovalBridge(node) {
    const listener = async (req, next) => {
        // Only answer for the agent the WeChat user is driving.
        if (!node.ownsAgent(req.agent))
            return next();
        const peer = node.peerId;
        if (!peer)
            return next();
        const number = node.nextApprovalNumber();
        const timeoutSec = node.config.approvalTimeoutSec;
        const prompt = [
            `🔐 ${sessionBadge(node, req.agent.session)} #${number} 需要你的确认`,
            `工具: ${req.toolName}`,
            ...(req.reason ? [`原因: ${req.reason}`] : []),
            `回复 /yes 同意，/no 拒绝（仅一条待确认时也可回复 1/2）`,
            `${Math.max(1, Math.round(timeoutSec / 60))} 分钟内未回复将自动拒绝。`,
        ].join('\n');
        // Show the question FIRST — the user cannot answer what they cannot see.
        void sendTextToPeer(node, prompt);
        const outcome = await new Promise((resolve) => {
            const timer = setTimeout(() => {
                node.clearApproval(number);
                resolve('rejected'); // default deny on timeout
            }, timeoutSec * 1000);
            timer.unref?.();
            node.registerApproval(number, { number, request: req, resolve, timer });
        });
        const label = outcome === 'allowed-once' ? '✅ 已同意' : outcome === 'rejected' ? '❌ 已拒绝' : `⏳ ${outcome}`;
        void sendTextToPeer(node, `${label} ${sessionBadge(node, req.agent.session)}（#${number}）`);
        return outcome;
    };
    const disposer = node.ctx.on('approval/request', listener);
    return () => {
        disposer();
    };
}
//# sourceMappingURL=approvals.js.map