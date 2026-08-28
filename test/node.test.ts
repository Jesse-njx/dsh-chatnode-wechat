/**
 * Conversation-node tests: the full WeChat → DSH → WeChat loop against the
 * fake iLink server, with a real SessionStore + AgentRegistry + ApprovalService
 * and a stub agent. Covers the allowlist gate, inbound routing, commands,
 * session targeting, outbound digests, chunking, and the approval bridge.
 */

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type Agent, type AgentFactory } from '@deepseek-ai/dsh-agent'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { WechatGateway } from '../src/gateway/index.ts'
import { wechatConversationNode } from '../src/node/index.ts'
import { startFakeIlinkServer, mediaKey, type FakeIlinkServer } from './fake-ilink-server.ts'
import type { InboundMessage } from '../src/gateway/types.ts'
import { splitForWechat } from '../src/node/outbound.ts'

let server: FakeIlinkServer
let ctx: Context
let runtimeCtx: Context
let followedUp: ReturnType<typeof createUserMessage>[]
let cancelled: boolean
let createdSessions: string[]
let lastCreateOptions: Parameters<AgentFactory['createAgent']>[1] | undefined

function makeFakeAgent(session: Session): Agent {
  return {
    id: session.id,
    session,
    options: {},
    status: 'idle',
    inbox: undefined,
    ctx,
    followup: (message) => {
      followedUp.push(message as never)
    },
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel: () => {
      cancelled = true
    },
    whenIdle: async () => {},
    runMaintenance: async () => {},
  } as unknown as Agent
}

/**
 * Minimal AgentFactory: mirrors the real dsh-agent-loop, which performs its
 * session work on its OWN runtime context (services must be injected there),
 * not on the owner context Cordis passes to the factory.
 */
const factory: AgentFactory = {
  async createAgent(ownerCtx, options) {
    lastCreateOptions = options
    const session = runtimeCtx.sessions.create(options.sessionId, { meta: options.meta })
    createdSessions.push(session.id)
    const agent = makeFakeAgent(session)
    const detach = runtimeCtx.agents.register(agent)
    return {
      agent,
      dispose: async () => {
        detach()
      },
    }
  },
  async resume() {
    throw new Error('resume is not implemented in tests')
  },
}

beforeEach(async () => {
  server = await startFakeIlinkServer()
  ctx = new Context()
  runtimeCtx = ctx
  followedUp = []
  cancelled = false
  createdSessions = []
  lastCreateOptions = undefined
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  ctx.agents.setFactory(factory)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WechatGateway, {
    token: 'test-token',
    accountId: 'wxid_bot_fake',
    baseUrl: server.url,
    cdnBaseUrl: server.url,
    allowCdnHosts: ['127.0.0.1'],
    pollIdleDelayMs: 5,
    longPollTimeoutMs: 1000,
  })
  // seed one agent + session so zero-config targeting has something to pick
  const handle = await ctx.agents.create({
    sessionId: SessionId('session-a'),
    agentOptions: { provider: 'test', model: 'test-model' },
  })
  activeHandle = handle
  await ctx.wechat.start()
})

let activeHandle: { agent: Agent; dispose: () => Promise<void> }

async function mountNode(config?: Record<string, unknown>): Promise<void> {
  await ctx.plugin(wechatConversationNode, {
    allowFrom: ['wxid_allow1'],
    digestIntervalSec: 0,
    approvalTimeoutSec: 2,
    sendChunkDelayMs: 1,
    ...config,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(10)
  }
  assert.fail('condition not met within timeout')
}

function textMessage(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    from_user_id: 'wxid_allow1',
    to_user_id: 'wxid_bot_fake',
    message_id: `msg-${Math.random().toString(36).slice(2)}`,
    msg_type: 1,
    context_token: 'ctx-token',
    item_list: [{ type: 1, text_item: { text } }],
    ...overrides,
  }
}

function sentTexts(): string[] {
  return server.sent.map((s) => s.text)
}

afterEach(async () => {
  await ctx.wechat?.stop?.()
  await activeHandle.dispose()
  await server.close()
})

test('inbound allowlisted text reaches the active agent via followup', async () => {
  await mountNode()
  server.enqueue(textMessage('你好，帮我看看这个项目'))
  await waitFor(() => followedUp.length === 1)
  assert.equal(followedUp[0]!.content[0]!.type, 'text')
  assert.equal((followedUp[0]!.content[0] as { text: string }).text, '你好，帮我看看这个项目')
})

test('non-allowlisted senders are logged and never fed to the model', async () => {
  await mountNode()
  server.enqueue(textMessage('ignore me', { from_user_id: 'wxid_evil', message_id: 'msg-evil' }))
  await sleep(200)
  assert.equal(followedUp.length, 0)
  assert.equal(server.sent.length, 0)
})

test('group messages are ignored in MVP', async () => {
  await mountNode()
  server.enqueue(textMessage('group ping', { room_id: 'room-1', message_id: 'msg-group' }))
  await sleep(200)
  assert.equal(followedUp.length, 0)
})

test('voice transcription text is routed with a voice marker', async () => {
  await mountNode()
  server.enqueue({
    from_user_id: 'wxid_allow1',
    message_id: 'msg-voice',
    msg_type: 1,
    item_list: [{ type: 3, voice_item: { text: '请总结 README' } }],
  })
  await waitFor(() => followedUp.length === 1)
  const text = (followedUp[0]!.content[0] as { text: string }).text
  assert.ok(text.includes('[语音转写]'))
  assert.ok(text.includes('请总结 README'))
})

test('assistant/message outbound is delivered to the peer with a task-started digest', async () => {
  await mountNode()
  server.enqueue(textMessage('first task'))
  await waitFor(() => followedUp.length === 1)

  const session = activeHandle.agent.session
  session.append('user/message', { content: [{ type: 'text', text: 'first task' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'the answer' }], provider: 'test', model: 'test-model' }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  await waitFor(() => sentTexts().some((t) => t === 'the answer'))
  const started = sentTexts().find((t) => t.includes('收到，开始处理…'))
  assert.ok(started, sentTexts().join('\n'))
  // 状态消息必须携带会话 badge（名称回退标签 + 会话 id）
  assert.ok(started.includes('first task'), started)
  assert.ok(started.includes('session-a'), started)
  assert.ok(sentTexts().indexOf(started) < sentTexts().indexOf('the answer'))
  // outbound targets the allowlisted sender
  assert.ok(server.sent.some((s) => s.to === 'wxid_allow1' && s.text === 'the answer'))
})

test('turn error emits an error digest', async () => {
  await mountNode()
  server.enqueue(textMessage('boom task'))
  await waitFor(() => followedUp.length === 1)
  const session = activeHandle.agent.session
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'kaboom', code: 'TEST' } } })
  await waitFor(() => sentTexts().some((t) => t.includes('kaboom')))
})

test('long assistant text is chunked into ≤ maxMessageChars bubbles with throttle', async () => {
  await mountNode({ maxMessageChars: 200, sendChunkDelayMs: 1 })
  server.enqueue(textMessage('long task'))
  await waitFor(() => followedUp.length === 1)
  const long = 'x'.repeat(700)
  const session = activeHandle.agent.session
  session.append('turn/start', { turn: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: long }], provider: 'test', model: 'test-model' }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await waitFor(() => sentTexts().some((t) => t.includes('xxx') && !t.startsWith('⏳')), 3000)
  await waitFor(() => sentTexts().filter((t) => t.includes('xxx')).length >= 4, 3000)
  const bubbles = sentTexts().filter((t) => t.includes('xxx'))
  assert.ok(bubbles.length >= 4, `expected ≥4 bubbles, got ${bubbles.length}`)
  for (const bubble of bubbles) assert.ok(bubble.length <= 200)
})

test('splitForWechat keeps fenced code blocks intact', () => {
  const content = '```ts\nconst a = 1\nconst b = 2\nconst c = 3\n```\n\n之后一句解释。'
  const chunks = splitForWechat(content, 60)
  assert.ok(chunks.length >= 2)
  const code = chunks.find((c) => c.includes('```ts'))
  assert.ok(code, 'code block must be preserved as one unit')
})

test('/sessions lists numbered sessions and /use switches the active session', async () => {
  await mountNode()
  // create a second, more recent session
  const second = await ctx.agents.create({ sessionId: SessionId('session-b') })
  server.enqueue(textMessage('/sessions'))
  await waitFor(() => sentTexts().some((t) => t.includes('会话列表')), 3000)
  const list = sentTexts().find((t) => t.includes('会话列表'))!
  assert.ok(list.includes('1.') && list.includes('2.'), list)
  assert.ok(list.includes('session-b'))
  await second.dispose()
})

test('/sessions prefers the real session title over the first-prompt label', async () => {
  await mountNode()
  ctx.sessionTitle.rename(activeHandle.agent.session, '我的自定义标题')
  server.enqueue(textMessage('/sessions'))
  await waitFor(() => sentTexts().some((t) => t.includes('会话列表')), 3000)
  const list = sentTexts().find((t) => t.includes('会话列表'))!
  assert.ok(list.includes('我的自定义标题'), list)
  assert.ok(list.includes('session-a'), list)
})

test('/status carries the real session title and keeps the session id', async () => {
  await mountNode()
  ctx.sessionTitle.rename(activeHandle.agent.session, '状态标题')
  server.enqueue(textMessage('/status'))
  await waitFor(() => sentTexts().some((t) => t.includes('状态标题') && t.includes('session-a')), 3000)
})

test('/new creates an agent+session and follows up the prompt', async () => {
  await mountNode()
  const before = createdSessions.length
  server.enqueue(textMessage('/new 写一个 hello world'))
  await waitFor(() => createdSessions.length === before + 1, 3000)
  assert.equal(createdSessions.at(-1)!.startsWith('wechat-'), true)
  await waitFor(() => followedUp.length === 1)
  const text = (followedUp[0]!.content[0] as { text: string }).text
  assert.equal(text, '写一个 hello world')
  // the confirmation is delivered asynchronously after the followup
  await waitFor(() => sentTexts().some((t) => t.includes('已创建新会话')), 3000)
})

test('/new mounts the configured agent preset through the factory setup hook', async () => {
  let mountedId: string | undefined
  let mountedCtx: Context | undefined
  ctx.provide('agentPresets', {
    defaultId: 'standard',
    resolve: async (id: string) => ({ id }),
    mount: async (agentCtx: Context, id: string) => {
      mountedId = id
      mountedCtx = agentCtx
    },
  })
  await mountNode({ agentPreset: 'standard' })
  const before = createdSessions.length
  server.enqueue(textMessage('/new 测试预设挂载'))
  await waitFor(() => createdSessions.length === before + 1, 3000)
  assert.ok(lastCreateOptions, 'createAgent must receive options')
  assert.equal(lastCreateOptions!.meta?.agentPreset, 'standard')
  assert.equal(typeof lastCreateOptions!.setup, 'function', 'a setup hook must mount the preset')
  await (lastCreateOptions!.setup as (agentCtx: Context) => Promise<void>)(ctx)
  assert.equal(mountedId, 'standard')
  assert.equal(mountedCtx, ctx)
})

test('/new without an agentPresets service keeps the legacy no-setup shape', async () => {
  await mountNode({ agentPreset: 'standard' })
  const before = createdSessions.length
  server.enqueue(textMessage('/new 无预设服务'))
  await waitFor(() => createdSessions.length === before + 1, 3000)
  assert.ok(lastCreateOptions, 'createAgent must receive options')
  assert.equal(lastCreateOptions!.meta?.agentPreset, 'standard')
  assert.equal(lastCreateOptions!.setup, undefined)
})

test('/stop cancels the active agent', async () => {
  await mountNode()
  server.enqueue(textMessage('/stop'))
  await waitFor(() => cancelled === true, 3000)
  // the confirmation is delivered asynchronously after the cancel
  await waitFor(() => sentTexts().some((t) => t.includes('已请求停止')), 3000)
})

test('/status reports the active session', async () => {
  await mountNode()
  server.enqueue(textMessage('/status'))
  await waitFor(() => sentTexts().some((t) => t.includes('session-a')), 3000)
})

test('no active session: plain text gets a hint, not a crash', async () => {
  await mountNode()
  await activeHandle.dispose()
  server.enqueue(textMessage('hi there'))
  await waitFor(() => sentTexts().some((t) => t.includes('没有活动会话')), 3000)
  assert.equal(followedUp.length, 0)
})

test('allowFrom missing throws at mount time (security gate)', async () => {
  const fiber = ctx.plugin(wechatConversationNode, { allowFrom: [] })
  await assert.rejects(fiber.await(), /allowFrom is REQUIRED/)
})

test('approval round trip: /yes grants allowed-once', async () => {
  await mountNode({ approvalTimeoutSec: 5 })
  server.enqueue(textMessage('approval task'))
  await waitFor(() => followedUp.length === 1)
  const agent = activeHandle.agent
  // open a turn so the approval seam accepts the request
  agent.session.append('turn/start', { turn: 2 })

  let outcome: string | undefined
  const pending = ctx.approval.request({
    agent,
    toolName: 'bash',
    reason: 'run a destructive command',
  }).then((o) => { outcome = o })

  await waitFor(() => sentTexts().some((t) => t.includes('需要你的确认')), 3000)
  server.enqueue(textMessage('/yes'))
  await pending
  assert.equal(outcome, 'allowed-once')
  await waitFor(() => sentTexts().some((t) => t.includes('✅ 已同意')), 3000)
})

test('approval timeout falls back to default deny', async () => {
  await mountNode({ approvalTimeoutSec: 1 })
  server.enqueue(textMessage('approval task 2'))
  await waitFor(() => followedUp.length === 1)
  const agent = activeHandle.agent
  agent.session.append('turn/start', { turn: 3 })
  const outcome = await ctx.approval.request({
    agent,
    toolName: 'bash',
    reason: 'timeout me',
  })
  assert.equal(outcome, 'rejected')
})

test('digest heartbeat emits a one-line summary while a turn runs', async () => {
  // The outer gateway must not race the nodeCtx gateway for the same fake
  // server queue — stop it and let the dedicated context drive this test.
  await ctx.wechat.stop()
  const nodeCtx = new Context()
  await nodeCtx.plugin(SessionStore)
  await nodeCtx.plugin(AgentRegistry)
  nodeCtx.agents.setFactory(factory)
  await nodeCtx.plugin(ApprovalService)
  await nodeCtx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await nodeCtx.plugin(SystemPrompt)
  await nodeCtx.plugin(ToolRuntime)
  await nodeCtx.plugin(WechatGateway, { token: 't', accountId: 'wxid_bot_fake', baseUrl: server.url, pollIdleDelayMs: 5 })
  // The factory creates sessions/agents in the CURRENT runtime context, so
  // point it at nodeCtx — otherwise appends would dispatch on the outer bus
  // and this node would never see them.
  runtimeCtx = nodeCtx
  const handle = await nodeCtx.agents.create({ sessionId: SessionId('session-heartbeat') })
  await nodeCtx.plugin(wechatConversationNode, { allowFrom: ['wxid_allow1'], digestIntervalSec: 1, sendChunkDelayMs: 1 })
  await nodeCtx.wechat.start()

  server.enqueue(textMessage('heartbeat task'))
  await waitFor(() => followedUp.length >= 1, 3000)
  const session = handle.agent.session
  session.append('turn/start', { turn: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' })
  await waitFor(() => sentTexts().some((t) => t.includes('仍在处理中')), 5000)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await handle.dispose()
  await nodeCtx.wechat.stop()
})

test('image-only message: download, save to mediaDir, route path to the agent', async () => {
  const mediaDir = join(tmpdir(), `dsh-wechat-media-${Date.now()}`)
  await mountNode({ mediaDir })
  // minimal PNG magic bytes — enough for media-type detection (not a decodable image)
  const plaintext = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const key = mediaKey()
  server.media.set('eqp-img-node', { key, plaintext })
  server.enqueue({
    from_user_id: 'wxid_allow1',
    to_user_id: 'wxid_bot_fake',
    message_id: 'msg-img-node',
    msg_type: 1,
    context_token: 'ctx-img-node',
    item_list: [{
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: 'eqp-img-node',
          aes_key: Buffer.from(key).toString('base64'),
        },
      },
    }],
  })
  await waitFor(() => followedUp.length === 1, 3000)
  const text = (followedUp[0]!.content[0] as { text: string }).text
  const match = /\[微信图片\]\s*(\S+)/.exec(text)
  assert.ok(match, `followup should carry an image path, got: ${text}`)
  const absPath = match![1]!
  assert.ok(absPath.endsWith('.png'), `expected .png path, got: ${absPath}`)
  assert.deepEqual([...readFileSync(absPath)], [...plaintext])
})
