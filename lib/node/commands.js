/**
 * WeChat command vocabulary: /sessions /use /new /stop /status /yes /no /help.
 *
 * Session targeting follows the spec: `/sessions` lists numbered sessions
 * (most recent first), `/use N` switches, `/new <prompt>` creates a fresh
 * agent+session, `/stop` cancels the active turn, `/status` reports the
 * active session. `/yes`/`/no` and bare `1`/`2` resolve pending approvals
 * (see `approvals.ts`).
 *
 * @module @dsh-cowork/chatnode-wechat/node/commands
 */
import { SessionId } from '@deepseek-ai/dsh-session';
import { sendTextToPeer } from "./outbound.js";
import { sessionBadge, sessionName } from "./labels.js";
/** Sessions ordered most-recent-first. */
export function listSessions(node) {
    return [...node.ctx.sessions.list()].sort((a, b) => {
        const diff = b.header.createdAt - a.header.createdAt;
        if (diff !== 0)
            return diff;
        return b.seq - a.seq;
    });
}
/** Try to route one command. Returns true when the text was a command. */
export async function routeCommand(node, text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/'))
        return false;
    // Approval replies are handled by the bridge even when no agent is active.
    if (trimmed === '/yes' || trimmed === '/no' || /^[12]$/.test(trimmed)) {
        if (node.resolveApproval(trimmed))
            return true;
    }
    const [command, ...rest] = trimmed.slice(1).split(/\s+/);
    switch (command) {
        case 'help':
            await sendTextToPeer(node, helpText());
            return true;
        case 'sessions':
            await sendTextToPeer(node, renderSessions(node));
            return true;
        case 'use': {
            const index = Number(rest[0]);
            const sessions = listSessions(node);
            if (!Number.isInteger(index) || index < 1 || index > sessions.length) {
                await sendTextToPeer(node, `❌ 无效编号。可用: 1–${sessions.length}（/sessions 查看列表）`);
                return true;
            }
            const session = sessions[index - 1];
            node.setActiveSession(session);
            await sendTextToPeer(node, `✅ 已切换到会话 #${index} ${sessionBadge(node, session)}`);
            return true;
        }
        case 'new': {
            const prompt = rest.join(' ').trim();
            await node.createSession(prompt);
            return true;
        }
        case 'stop': {
            const agent = node.activeAgent();
            if (!agent) {
                await sendTextToPeer(node, '❌ 没有活动的 agent');
            }
            else {
                agent.cancel({ kind: 'user' });
                await sendTextToPeer(node, '⏹ 已请求停止');
            }
            return true;
        }
        case 'status': {
            const agent = node.activeAgent();
            const session = node.activeSession();
            if (!session) {
                await sendTextToPeer(node, '💤 没有活动会话。发送 /new <prompt> 开始，或 /sessions 查看已有会话。');
                return true;
            }
            const status = agent?.status ?? 'idle';
            const lastTurn = [...session.events].reverse().find((e) => e.type === 'turn/end');
            const reason = lastTurn ? describeTurnEnd(lastTurn.data.reason) : '尚未运行';
            await sendTextToPeer(node, `📊 状态\n会话: ${sessionBadge(node, session)}\nagent: ${status}\n事件: ${session.seq} 条\n最近: ${reason}`);
            return true;
        }
        case 'send': {
            const target = rest.join(' ').trim();
            if (!target) {
                await sendTextToPeer(node, '❌ 用法: /send <图片文件路径>');
                return true;
            }
            const peer = node.peerId;
            if (!peer) {
                await sendTextToPeer(node, '❌ 没有可回复的联系人');
                return true;
            }
            await sendTextToPeer(node, '🖼 正在发送图片…');
            const result = await node.ctx.wechat.sendImage(peer, target);
            await sendTextToPeer(node, result.success ? '✅ 图片已发送' : `❌ 发送失败: ${result.error}`);
            return true;
        }
        default:
            await sendTextToPeer(node, `❓ 未知命令 /${command}\n${helpText()}`);
            return true;
    }
}
function describeTurnEnd(reason) {
    switch (reason.kind) {
        case 'completed': return '✅ 完成';
        case 'error': return '❌ 出错';
        case 'aborted': return '⏹ 已停止';
        case 'blocked': return '⏸ 已阻塞';
        case 'max-tokens': return '⚠️ 输出截断';
        case 'interrupted': return '⚠️ 中断';
        default: return reason.kind;
    }
}
function renderSessions(node) {
    const sessions = listSessions(node);
    if (sessions.length === 0)
        return '📋 没有会话。发送 /new <prompt> 开始。';
    const lines = sessions.map((session, i) => {
        const marker = session.id === node.activeSessionId ? ' ▶' : '';
        return `${i + 1}. ${sessionName(node, session)} — ${session.id}${marker}`;
    });
    return `📋 会话列表（/use N 切换）\n${lines.join('\n')}`;
}
function helpText() {
    return [
        '🤖 dsh-chatnode-wechat 命令',
        '/sessions — 列出会话',
        '/use N — 切换到会话 N',
        '/new <prompt> — 新建会话并开始',
        '/stop — 停止当前任务',
        '/status — 查看状态',
        '/send <路径> — 发送一张图片',
        '/yes /no 或 1/2 — 回应权限请求',
        '/help — 本帮助',
    ].join('\n');
}
/** Default session id prefix for /new-created sessions. */
export function newSessionId(node) {
    return SessionId(`wechat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}
//# sourceMappingURL=commands.js.map