# dsh-chatnode-wechat

**在微信里与你的 DSH agent 对话、监控、审批。**

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
bundle，通过腾讯非官方 **iLink bot 网关**（`ilinkai.weixin.qq.com`）把 DSH
profile 接到微信个人账号 —— 与 hermes-agent、OpenClaw 同机制。文字与图片
双向收发（微信发图自动下载解密交给 agent，`/send` 把图片发回微信），
支持 `/sessions /use /new /stop /status` 会话管理，权限请求直接在聊天里用
`/yes` / `/no` 回答，进度以摘要形式推送而不是刷屏式工具调用。

```
你 (微信)  ⇄  iLink  ⇄  wechat-gateway  ⇄  wechat-conversation-node  ⇄  DSH agent 会话
```

Bundle 内含**两个可分离的 Cordis 插件**：

| 插件 | 职责 |
| --- | --- |
| `wechat-gateway`（`WechatGateway`） | iLink 服务（`ctx.wechat`）：扫码登录、鉴权长轮询、断线重连/退避、发送重试 + 限流熔断、正在输入指示、加密 CDN 媒体下载/上传（`downloadImage` / `sendImage`）。 |
| `wechat-conversation-node` | 微信 ⇄ DSH 桥：allowlist 白名单闸门、会话定位、命令、摘要式出站（分块 + 限速）、审批。 |

## ⚠️ 先读这里

- **一个账号一个轮询者。** iLink 每个 bot token 只允许一个鉴权轮询者。如果
  你在同一个微信账号上还跑 **hermes-agent** 或 **OpenClaw**，其中一方会收到
  HTTP 403 并丢消息。请为 agent 使用**专用微信账号**，并且绝不要用同一个
  token 跑两个本 bundle 实例。
- **非官方网关。** 与 hermes/openclaw 同机制，腾讯可能限制该账号。再次建议：
  使用可以接受的专用账号。
- **非官方协议。** iLink 细节是从 hermes-agent 源码逆向的，而非腾讯文档。
  录制好的转录样本在 `test/fixtures/inbound.ndjson`，CI 不需要真实账号。

## 安装

```sh
git clone https://github.com/Jesse-njx/dsh-chatnode-wechat.git
cd dsh-chatnode-wechat
pnpm install && pnpm build
dsh plugin --profile <your-profile> add .
```

凭据通过 **dsh credentials 服务**保存 —— 绝不写在 patch 文件里。先配对一次：

```sh
pnpm login          # 打印二维码链接，用微信扫码并确认
```

这会向 `$DSH_HOME/.credentials.yaml` 写入 `WEIXIN_ACCOUNT_ID` /
`WEIXIN_BOT_TOKEN` / `WEIXIN_BASE_URL`（经 `dsh-credentials-local`）。bundle
启动时解析并自动开始轮询。

## 配置

```yaml
# profile patch（cordis.patch.yml）
plugins:
  dsh-chatnode-wechat:
    allowFrom: ["<your-wechat-id>"]   # 硬白名单，必填，无默认值
    digestIntervalSec: 300            # 运行中每 N 秒发一条进度摘要
    approvalTimeoutSec: 600           # 审批超时 → 默认拒绝
    maxMessageChars: 2000             # 微信单条气泡上限（协议限制）
    sendChunkDelayMs: 1500            # 出站气泡间隔限速
    # cwd: /path/to/workspace         # `/new` 会话的工作目录
    # mediaDir: /path/to/media        # 入站图片落盘目录（默认 $DSH_HOME/attachments/wechat）
    # agentPreset: <preset-name>      # `/new` 会话使用的 agent preset
    # agentProvider / agentModel: ... # `/new` agent 的模型路由
```

`allowFrom` **必填且没有宽松默认值**：接受任意微信联系人的指令等于把 prompt
注入的大门敞开。白名单外的消息只记日志、直接忽略，永远不会喂给模型。

## 用法

给机器人发文字或图片即可。只要存在至少一个会话就是零配置 —— 默认目标是
**最近的一个会话**。

### 图片收发

- **收图**：直接给机器人发图片，网关会下载解密（加密 CDN + AES-128-ECB），
  落盘到 `mediaDir`（默认 `$DSH_HOME/attachments/wechat/`），并把文件路径交给
  agent —— agent 用 `read_image`/vision 工具识别内容。
- **发图**：`/send <绝对路径>` 把一张本地图片发回当前联系人（AES 加密 →
  `getuploadurl` → CDN 上传 → `sendmessage`）。发送依赖该 peer 的
  `context_token`，因此由网关进程内执行。

| 命令 | 作用 |
| --- | --- |
| *(普通文字)* | 路由到当前 agent（`agent.followup`） |
| *(图片)* | 下载解密落盘，把文件路径交给 agent 识别 |
| `/sessions` | 编号会话列表（最近优先） |
| `/use N` | 切换活动会话 |
| `/new <prompt>` | 新建 agent+会话并开始 |
| `/stop` | 取消当前任务 |
| `/status` | agent 状态 + 会话摘要 |
| `/send <路径>` | 发送一张本地图片给当前联系人 |
| `/yes` `/no`（仅一条待确认时也可 `1`/`2`） | 回答权限请求 |
| `/help` | 命令列表 |

出站是摘要式的，绝不刷屏：

- 回合开始时 `⏳ 收到，开始处理…`
- 每 `digestIntervalSec` 一条 `🔄 仍在处理中…` 心跳
- assistant 的实际文字（按 `maxMessageChars` 分块、限速）
- 回合结束时 `❌ 出错…` / `⏹ 已停止` / `⚠️ 输出截断`
- `🔐 #N 需要你的确认` 权限提示，聊天内直接回答

## 审批

微信个人账号没有按钮。DSH 权限请求触发时，桥接层渲染成编号文本提示并等待：

```
🔐 #1 需要你的确认
工具: bash
原因: run a destructive command
回复 /yes 同意，/no 拒绝（仅一条待确认时也可回复 1/2）
10 分钟内未回复将自动拒绝。
```

`/yes`（仅一条待确认时 `1`）授予 `allowed-once`；`/no`（`2`）拒绝；超时回退到
DSH 默认**拒绝**。桥接层只回答当前微信用户驱动的 agent 的请求，其余请求沿
answerer 链继续委托。

## 开发

```sh
pnpm install
pnpm -r build
pnpm --filter @dsh-cowork/chatnode-wechat test   # 36 个测试，无需微信账号
```

- `test/fake-ilink-server.ts` 实现了 iLink 端点（getupdates 长轮询、
  sendmessage、sendtyping、getconfig、扫码登录、加密 CDN），回放
  `test/fixtures/inbound.ndjson`；完整的 入站→会话→出站 循环在 CI 中运行。
- `pnpm smoke` 是手动真机脚本（设置 `WEIXIN_ALLOW_FROM`）。
- 锁定 dsh-base 家族版本（本仓库 `@deepseek-ai/*` 为 `0.1.0-rc.6`）—— DSH
  是开发者预览版，上游可能有破坏性变更。

## 风险

| 风险 | 对策 |
| --- | --- |
| **iLink 独占锁** — 同一 token 两个轮询者 → 403 + 丢消息 | 专用账号；遇 403 大声报错并停止轮询；文档中明确共存警告 |
| **账号风险** — 非官方网关 | 专用账号；本 README 明示 |
| **DSH v0.1 变更** | 锁定 `@deepseek-ai/*` 依赖；CI 针对锁定版本 |
| **协议不透明** | 协议移植自 hermes-agent；已录制样本，重构无需真实账号 |

## Roadmap

- **v0.1（本包）**：扫码登录、双向文字、会话定位、命令、审批、摘要、白名单。
- **v0.2**：双向图片 ✅（见上文「图片收发」）、双向文件、出站语音回复。
- **v0.3**：群聊（高风险）、多账号、hermesclaw 式共享轮询代理（与
  hermes/openclaw 共存）。
- **后续**：复用 `node/` 层的企业微信 / 钉钉 / 飞书 bundle。

## License

MIT —— 见 [LICENSE](LICENSE)。
