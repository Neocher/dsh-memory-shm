// Exercises the shipping plugin body on a real ToolRuntime with a stubbed SHM
// service: configuration resolution, the pure recall helpers, and every tool's
// canonical value, rendered text, and failure behavior.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as memory from '../src/index.ts'
import type { Config, RecallOutcome } from '../src/index.ts'

const SIGNAL = new AbortController().signal

let context: Context | undefined

afterEach(() => {
  vi.unstubAllGlobals()
  return context?.fiber.dispose()
})

/** Boot the real plugin on a real tool runtime with the given configuration. */
async function setup(config: Partial<Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(memory, { writeEnabled: false, ...config })
  context = ctx
  return ctx
}

/** Answer every SHM request with one canned JSON document. */
function serve(body: unknown, status = 200): URL[] {
  const urls: URL[] = []
  vi.stubGlobal('fetch', async (url: URL) => {
    urls.push(url)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
  return urls
}

let callCounter = 0

/** Invoke one registered tool through the real executor. */
function call(ctx: Context, name: string, args: unknown): Promise<{ content: { type: string; text?: string }[]; isError: boolean }> {
  callCounter += 1
  return ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId(`call-${callCounter}`),
    name,
    arguments: args,
  })
}

/** The JSON body one stubbed request carried, when it carried one. */
function sentBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

/** Concatenate the text blocks of one tool result. */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** One user message carrying exactly the given text and source kind. */
function userMessage(text_: string, kind: 'user' | typeof memory.name = 'user'): UserMessage {
  const source = kind === 'user'
    ? { kind: 'user' as const }
    : { kind: memory.name, form: 'recall' } as const
  return createUserMessage({ content: [{ type: 'text', text: text_ }], source })
}

describe('resolveConfig', () => {
  it('applies the documented defaults and leaves recall off', () => {
    const resolved = memory.resolveConfig({ writeEnabled: false })

    expect(resolved).toEqual({
      gateway: { baseUrl: 'http://127.0.0.1:8000', timeoutMs: 10_000 },
      writeEnabled: false,
      maxWriteChars: 20_000,
      recall: undefined,
    })
  })

  it('resolves an enabled recall block and keeps an explicit token', () => {
    const resolved = memory.resolveConfig({
      writeEnabled: true,
      baseUrl: 'http://shm.internal:9000',
      namespace: 'harness',
      timeoutMs: 2_500,
      maxWriteChars: 512,
      token: 'secret',
      recall: { enabled: true },
    })

    expect(resolved).toEqual({
      gateway: { baseUrl: 'http://shm.internal:9000', namespace: 'harness', timeoutMs: 2_500, token: 'secret' },
      writeEnabled: true,
      maxWriteChars: 512,
      recall: { topK: memory.DEFAULTS.recallTopK, maxChars: memory.DEFAULTS.recallMaxChars },
    })
  })

  it('treats an explicitly disabled recall block as off', () => {
    expect(memory.resolveConfig({ writeEnabled: false, recall: { enabled: false, topK: 9 } }).recall).toBeUndefined()
  })

  it('rejects values that cannot bound a request', () => {
    expect(() => memory.resolveConfig({ writeEnabled: false, timeoutMs: 0 }))
      .toThrow(/timeoutMs must be a positive safe integer/)
    expect(() => memory.resolveConfig({ writeEnabled: false, maxWriteChars: 1.5 }))
      .toThrow(/maxWriteChars must be a positive safe integer/)
    expect(() => memory.resolveConfig({ writeEnabled: false, recall: { enabled: true, topK: 0 } }))
      .toThrow(/recall\.topK must be a positive safe integer/)
    expect(() => memory.resolveConfig({ writeEnabled: false, recall: { enabled: true, maxChars: -1 } }))
      .toThrow(/recall\.maxChars must be a positive safe integer/)
  })

  it('rejects a retrieval size above the forwarding ceiling', () => {
    expect(() => memory.resolveConfig({ writeEnabled: false, recall: { enabled: true, topK: 51 } }))
      .toThrow(/recall\.topK must not exceed 50/)
  })

  it('rejects identity fields that cannot address a namespace', () => {
    expect(() => memory.resolveConfig({ writeEnabled: false, namespace: '' }))
      .toThrow(/namespace must be a non-empty string/)
    expect(() => memory.resolveConfig({ writeEnabled: false, token: '' }))
      .toThrow(/token must be a non-empty string/)
  })
})

describe('newUserRequest', () => {
  it('returns the newest ordinary user request', () => {
    expect(memory.newUserRequest([userMessage('first'), userMessage('second')])).toBe('second')
  })

  it('ignores plugin-injected context and requests too short to search', () => {
    expect(memory.newUserRequest([userMessage('x'), userMessage('recalled', memory.name)])).toBeUndefined()
    expect(memory.newUserRequest([userMessage('asked', memory.name), userMessage('real question')])).toBe('real question')
  })

  it('returns undefined when the step carries no user input', () => {
    expect(memory.newUserRequest([])).toBeUndefined()
  })
})

describe('renderRecall', () => {
  const outcome: RecallOutcome = {
    query: 'q',
    strategyUsed: 'auto',
    totalFound: 2,
    latencyMs: 1,
    degraded: false,
    memories: [
      { nodeId: 'n1', content: 'alpha', score: 0.912_34, source: 'episodic' },
      { nodeId: 'n2', content: 'beta '.repeat(40).trim(), score: 0.5 },
    ],
  }

  it('frames entries as untrusted data and keeps ranking order', () => {
    const rendered = memory.renderRecall(outcome, 1_000)

    expect(rendered.split('\n')[0]).toBe(memory.RECALL_HEADER)
    expect(rendered).toContain('Query: q')
    expect(rendered).toContain('1. [score 0.912, source episodic] alpha')
    expect(rendered).toContain('2. [score 0.500] beta')
  })

  it('drops entries that exceed the character budget and says so', () => {
    const budget = memory.renderRecall(outcome, 1_000).split('\n').slice(0, 3).join('\n').length + 80
    const rendered = memory.renderRecall(outcome, budget)

    expect(rendered.length).toBeLessThanOrEqual(budget)
    expect(rendered).toContain('alpha')
    expect(rendered).not.toContain('beta')
    expect(rendered).toContain('More memories matched')
  })

  it('renders nothing when not even the first entry fits', () => {
    expect(memory.renderRecall(outcome, 10)).toBe('')
  })
})

describe('memory tools', () => {
  it('recalls memories and renders them for the model', async () => {
    const urls = serve({
      query: 'what did we decide',
      strategy_used: 'vector',
      results: [{ node_id: 'n1', content: 'we chose SQLite', score: 0.77 }],
      total_found: 1,
      latency_ms: 4,
      degraded: false,
    })
    const ctx = await setup()

    const result = await call(ctx, 'memory_recall', { query: 'what did we decide', top_k: 2 })

    expect(result.isError).toBe(false)
    expect(urls[0]?.pathname).toBe('/memories/retrieve')
    expect(text(result)).toBe('1 memories matched "what did we decide" (strategy vector):\n1. [score 0.770] we chose SQLite')
  })

  it('reports an empty recall as a successful result', async () => {
    serve({ query: 'nothing', results: [], total_found: 0, strategy_used: 'auto' })
    const ctx = await setup()

    const result = await call(ctx, 'memory_recall', { query: 'nothing' })

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('No memories matched "nothing" (strategy auto, 0 found).')
  })

  it('clamps the requested retrieval size and defaults it without one', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
      bodies.push(sentBody(init))
      return new Response(JSON.stringify({ query: 'q', results: [] }), { headers: { 'content-type': 'application/json' } })
    })
    const ctx = await setup({ recall: { enabled: true, topK: 4 } })

    await call(ctx, 'memory_recall', { query: 'q', top_k: 900 })
    await call(ctx, 'memory_recall', { query: 'q' })

    expect(bodies).toEqual([
      { query: 'q', top_k: 50 },
      { query: 'q', top_k: 4 },
    ])
  })

  it('reports a service failure as an error result', async () => {
    serve({ error: 'boom' }, 503)
    const ctx = await setup()

    const result = await call(ctx, 'memory_recall', { query: 'q' })

    expect(result.isError).toBe(true)
    expect(text(result)).toContain('HTTP 503')
  })

  it('omits the write tool unless the deployment enables writes', async () => {
    const off = await setup()
    expect(off.tools.get('memory_write')).toBeUndefined()

    const on = await setup({ writeEnabled: true })
    expect(on.tools.get('memory_write')).toBeDefined()
    expect(on.tools.get('memory_write')?.description).toContain('Store one entry in long-term memory')
  })

  it('stores an episode with the configured namespace and reports its id', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
      bodies.push(sentBody(init))
      return new Response(
        JSON.stringify({ episode_id: 'e1', created_at: 42, status: 'created' }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    const ctx = await setup({ writeEnabled: true, namespace: 'harness' })

    const result = await call(ctx, 'memory_write', { content: '  keep this  ', source: 'dsh' })

    expect(result.isError).toBe(false)
    expect(bodies).toEqual([{ content: 'keep this', source: 'dsh', namespace: 'harness' }])
    expect(text(result)).toBe('Stored memory e1 (created).')
  })

  it('rejects empty and oversized writes before calling the service', async () => {
    const urls = serve({ episode_id: 'e1', created_at: 42, status: 'created' })
    const ctx = await setup({ writeEnabled: true, maxWriteChars: 8 })

    const empty = await call(ctx, 'memory_write', { content: '   ' })
    expect(empty.isError).toBe(true)
    expect(text(empty)).toContain('requires non-empty content')

    const oversized = await call(ctx, 'memory_write', { content: 'x'.repeat(9) })
    expect(oversized.isError).toBe(true)
    expect(text(oversized)).toContain('above the configured limit of 8')

    expect(urls).toEqual([])
  })

  it('reports service health with its statistics', async () => {
    serve({
      status: 'ok',
      graph_connected: true,
      faiss_loaded: true,
      dream_scheduler_running: false,
      stats: { version: '6.23.0', node_count: 7 },
    })
    const ctx = await setup()

    const result = await call(ctx, 'memory_health', {})

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('SHM healthy: status=ok, graph=true, vector=true, version=6.23.0')
  })
})
