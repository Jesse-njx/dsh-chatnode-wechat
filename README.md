# dsh-chatnode-wechat

**Chat with, monitor, and approve your DSH agents from WeChat.**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle
that connects a DSH profile to a WeChat personal account over Tencent's
unofficial **iLink bot gateway** (`ilinkai.weixin.qq.com`) — the same
mechanism hermes-agent and OpenClaw use. Text and images go both ways
(inbound images are downloaded, decrypted and handed to the agent; `/send`
sends an image back), session targeting works with
`/sessions /use /new /stop /status`, permission requests are answered with
`/yes` / `/no` right in the chat, and progress is reported as digest-style
messages instead of a tool-call firehose.

```
你 (WeChat)  ⇄  iLink  ⇄  wechat-gateway  ⇄  wechat-conversation-node  ⇄  DSH agent session
```

The bundle ships **two separable Cordis plugins**:

| Plugin | Role |
| --- | --- |
| `wechat-gateway` (`WechatGateway`) | iLink service (`ctx.wechat`): QR login, authenticated long-poll, reconnect/backoff, send retry + rate-limit circuit, typing indicator, encrypted CDN media download/upload (`downloadImage` / `sendImage`). |
| `wechat-conversation-node` | WeChat ⇄ DSH bridge: allowlist gate, session targeting, commands, digest outbound (chunked + throttled), approvals. |

## ⚠️ Read this first

- **One poller per account.** iLink allows exactly ONE authenticated poller
  per bot token. If you also run **hermes-agent** or **OpenClaw** on the same
  WeChat account, one of them gets HTTP 403s and drops messages. Use a
  **dedicated WeChat account** for the agent, and never run two instances of
  this bundle against the same token.
- **Unofficial gateway.** This rides the same unofficial mechanism as
  hermes/openclaw; Tencent could restrict the account. Again: use a dedicated
  account you are willing to lose.
- **Unofficial protocol.** iLink details are reconstructed from hermes-agent
  source, not Tencent docs. Recorded transcripts live in
  `test/fixtures/inbound.ndjson` so CI never needs a live account.

## Install

```sh
git clone https://github.com/Jesse-njx/dsh-chatnode-wechat.git
cd dsh-chatnode-wechat
pnpm install && pnpm build
dsh plugin --profile <your-profile> add .
```

Credentials are stored through the **dsh credentials service** — never in the
patch file. Pair your WeChat account once:

```sh
pnpm login          # prints a QR URL; scan it with WeChat and confirm
```

This writes `WEIXIN_ACCOUNT_ID` / `WEIXIN_BOT_TOKEN` / `WEIXIN_BASE_URL` to
`$DSH_HOME/.credentials.yaml` (via `dsh-credentials-local`). The bundle
resolves them at boot and starts polling automatically.

## Configuration

```yaml
# profile patch (cordis.patch.yml)
plugins:
  dsh-chatnode-wechat:
    allowFrom: ["<your-wechat-id>"]   # hard allowlist, REQUIRED, no default
    digestIntervalSec: 300            # heartbeat summary while a turn runs
    approvalTimeoutSec: 600           # approval prompt timeout → default deny
    maxMessageChars: 2000             # WeChat bubble cap (protocol limit)
    sendChunkDelayMs: 1500            # throttle between outbound bubbles
    # cwd: /path/to/workspace         # working dir for `/new` sessions
    # mediaDir: /path/to/media        # inbound image dir (default $DSH_HOME/attachments/wechat)
    # agentPreset: <preset-name>      # agent preset for `/new` sessions
    # agentProvider / agentModel: ... # model route for `/new` agents
```

`allowFrom` is **mandatory with no permissive default**: an agent that accepts
instructions from any WeChat contact is a prompt-injection front door.
Messages from non-allowlisted senders are logged and ignored — they are never
fed to the model.

## Usage

Send text or images to the bot. Everything is zero-config once one session
exists — the **most recent session** is the default target.

### Images

- **Inbound**: send an image to the bot; the gateway downloads and decrypts it
  (encrypted CDN + AES-128-ECB), persists it under `mediaDir` (default
  `$DSH_HOME/attachments/wechat/`), and hands the file path to the agent,
  which decodes it with its `read_image`/vision tool.
- **Outbound**: `/send <absolute-path>` sends a local image back to the
  current contact (AES-encrypt → `getuploadurl` → CDN upload →
  `sendmessage`). Sending depends on the peer's `context_token`, so it runs
  inside the gateway process.

| Command | What it does |
| --- | --- |
| *(plain text)* | routes to the active agent (`agent.followup`) |
| *(image)* | downloaded, decrypted, saved, path handed to the agent |
| `/sessions` | numbered session list (most recent first) |
| `/use N` | switch the active session |
| `/new <prompt>` | create a fresh agent+session and start |
| `/stop` | cancel the active turn |
| `/status` | agent status + session summary |
| `/send <path>` | send a local image to the current contact |
| `/yes` `/no` (or `1`/`2` while one request is pending) | answer a permission request |
| `/help` | command list |

Outbound is digest-style, never a mirror of every tool call:

- `⏳ 收到，开始处理…` when a turn starts,
- a one-line `🔄 仍在处理中…` heartbeat every `digestIntervalSec`,
- the assistant's actual text (chunked to `maxMessageChars`, throttled),
- `❌ 出错…` / `⏹ 已停止` / `⚠️ 输出截断` on turn end,
- `🔐 #N 需要你的确认` permission prompts, answered in-chat.

## Approvals

WeChat personal accounts have no buttons. When a DSH permission request
fires, the bridge renders it as a numbered text prompt and waits:

```
🔐 #1 需要你的确认
工具: bash
原因: run a destructive command
回复 /yes 同意，/no 拒绝（仅一条待确认时也可回复 1/2）
10 分钟内未回复将自动拒绝。
```

`/yes` (or `1` while exactly one request is pending) grants `allowed-once`;
`/no` (`2`) rejects; a timeout falls back to DSH's default **deny**. The
bridge only answers requests for the agent currently driven by the WeChat
user — anything else is delegated down the answerer chain.

## Development

```sh
pnpm install
pnpm -r build
pnpm --filter @dsh-cowork/chatnode-wechat test   # 36 tests, no WeChat account
```

- `test/fake-ilink-server.ts` implements the iLink endpoints (getupdates
  long-poll, sendmessage, sendtyping, getconfig, QR login, encrypted CDN) and
  replays `test/fixtures/inbound.ndjson`; the full
  inbound→session→outbound loop runs in CI.
- `pnpm smoke` is the manual live-account script (set `WEIXIN_ALLOW_FROM`).
- Pin the dsh-base family (`@deepseek-ai/*` at `0.1.0-rc.6` in this repo) —
  DSH is a developer preview and upstream breaks are expected.

## Risks

| Risk | Mitigation |
| --- | --- |
| **iLink exclusive lock** — two pollers on one token → 403 + dropped messages | Dedicated account; loud fatal error + polling stop on 403; documented coexistence warning |
| **Account restriction** — unofficial gateway | Dedicated account; stated plainly in this README |
| **DSH v0.1 churn** | Pinned `@deepseek-ai/*` deps; CI against the pinned versions |
| **Protocol opacity** | Protocol ported from hermes-agent; fixtures recorded so refactors need no live account |

## Roadmap

- **v0.1 (this package)**: QR login, text both directions, session targeting,
  commands, approvals, digests, allowlist.
- **v0.2**: images both directions ✅ (see "Images" above), files both
  directions, outbound voice replies.
- **v0.3**: group chats (risk-heavy), multi-account, a hermesclaw-style
  shared-poller proxy so the bundle can coexist with hermes/openclaw.
- **Later**: WeCom / DingTalk / Feishu bundles sharing the `node/` layer.

## License

MIT — see [LICENSE](LICENSE).
