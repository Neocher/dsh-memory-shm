// The gateway sits on a process boundary, so these cases pin the wire request it
// builds and the failure class it reports for each way the service can answer.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShmError, ShmGateway } from '../src/client.ts'

const OPTIONS = {
  baseUrl: 'http://127.0.0.1:8123',
  namespace: 'test-ns',
  timeoutMs: 1_000,
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** JSON response the fake service returns for the next request. */
function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** The JSON body the gateway sent, when it sent one. */
function sentBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

/** Capture the request the gateway issues and answer it with one canned response. */
function capture(response: Response | (() => Promise<Response>)): { url: URL | undefined; init: RequestInit | undefined } {
  const seen: { url: URL | undefined; init: RequestInit | undefined } = { url: undefined, init: undefined }
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    seen.url = url
    seen.init = init
    return typeof response === 'function' ? await response() : response
  })
  return seen
}

describe('ShmGateway', () => {
  it('posts a namespaced retrieval and normalizes the wire document', async () => {
    const seen = capture(respond({
      query: 'what changed',
      strategy_used: 'hybrid',
      results: [
        { node_id: 'n1', content: 'first', score: 0.9, source: 'episodic', tau_value: 0.5 },
        { node_id: 'n2', content: 'second', score: 0.4 },
      ],
      total_found: 2,
      latency_ms: 12.5,
      degraded: true,
    }))

    const outcome = await new ShmGateway(OPTIONS).retrieve('what changed', 5)

    expect(seen.url?.pathname).toBe('/memories/retrieve')
    expect(seen.init?.method).toBe('POST')
    expect(sentBody(seen.init)).toEqual({
      query: 'what changed',
      top_k: 5,
      namespace: 'test-ns',
    })
    expect(outcome).toEqual({
      query: 'what changed',
      strategyUsed: 'hybrid',
      totalFound: 2,
      latencyMs: 12.5,
      degraded: true,
      memories: [
        { nodeId: 'n1', content: 'first', score: 0.9, source: 'episodic', tauValue: 0.5 },
        { nodeId: 'n2', content: 'second', score: 0.4 },
      ],
    })
  })

  it('fills absent optional wire fields with the service defaults', async () => {
    capture(respond({ query: 'q', results: [{ node_id: 'n1', content: 'c', score: 0.1 }] }))

    const outcome = await new ShmGateway(OPTIONS).retrieve('q', 1)

    expect(outcome.strategyUsed).toBe('auto')
    expect(outcome.totalFound).toBe(0)
    expect(outcome.latencyMs).toBe(0)
    expect(outcome.degraded).toBe(false)
  })

  it('omits an unset namespace so the request stays service-wide', async () => {
    const seen = capture(respond({ query: 'q', results: [] }))

    await new ShmGateway({ baseUrl: OPTIONS.baseUrl, timeoutMs: OPTIONS.timeoutMs }).retrieve('q', 1)

    expect(sentBody(seen.init)).toEqual({ query: 'q', top_k: 1 })
  })

  it('sends a bearer token only when one is configured', async () => {
    const withToken = capture(respond({ query: 'q', results: [] }))
    await new ShmGateway({ ...OPTIONS, token: 'secret' }).retrieve('q', 1)
    expect((withToken.init?.headers as Record<string, string>).authorization).toBe('Bearer secret')

    const withoutToken = capture(respond({ query: 'q', results: [] }))
    await new ShmGateway(OPTIONS).retrieve('q', 1)
    expect((withoutToken.init?.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('posts an episode and normalizes the write outcome', async () => {
    const seen = capture(respond({ episode_id: 'e1', created_at: 1_700_000_000_000, status: 'quarantined' }))

    const written = await new ShmGateway(OPTIONS).writeEpisode('remember this', 'dsh')

    expect(seen.url?.pathname).toBe('/memories/episodes')
    expect(sentBody(seen.init)).toEqual({
      content: 'remember this',
      source: 'dsh',
      namespace: 'test-ns',
    })
    expect(written).toEqual({ episodeId: 'e1', status: 'quarantined', createdAt: 1_700_000_000_000 })
  })

  it('reports health, including a disconnected graph as unhealthy', async () => {
    capture(respond({
      status: 'ok',
      graph_connected: true,
      faiss_loaded: true,
      dream_scheduler_running: true,
      stats: { version: '6.23.0', node_count: 7711 },
    }))
    const healthy = await new ShmGateway(OPTIONS).health()
    expect(healthy).toEqual({
      healthy: true,
      status: 'ok',
      graphConnected: true,
      vectorIndexLoaded: true,
      dreamSchedulerRunning: true,
      version: '6.23.0',
      nodeCount: 7711,
    })

    capture(respond({ status: 'ok', graph_connected: false, faiss_loaded: true }))
    const degraded = await new ShmGateway(OPTIONS).health()
    expect(degraded.healthy).toBe(false)
    expect(degraded.version).toBeUndefined()
    expect(degraded.nodeCount).toBeUndefined()
  })

  it('classifies a rejected request with its status and a bounded excerpt', async () => {
    capture(respond({ error: 'unauthorized' }, 401))

    const failure = await new ShmGateway(OPTIONS).retrieve('q', 1).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ShmError)
    expect(failure).toMatchObject({ kind: 'http', status: 401 })
    expect(String(failure)).toContain('HTTP 401')
    expect(String(failure)).toContain('unauthorized')
  })

  it('classifies an unparseable body as an invalid response', async () => {
    capture(new Response('not json', { status: 200 }))

    await expect(new ShmGateway(OPTIONS).health()).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('classifies a document missing required fields as an invalid response', async () => {
    capture(respond({ status: 'ok' }))

    await expect(new ShmGateway(OPTIONS).health()).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('classifies a transport failure as unreachable', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED') })

    const failure = await new ShmGateway(OPTIONS).health().catch((error: unknown) => error)

    expect(failure).toMatchObject({ kind: 'unreachable' })
    expect(String(failure)).toContain('http://127.0.0.1:8123')
  })

  it('classifies an exceeded deadline as a timeout', async () => {
    vi.stubGlobal('fetch', (_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal
      signal?.addEventListener('abort', () => {
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new Error('request aborted'))
      })
    }))

    await expect(new ShmGateway({ ...OPTIONS, timeoutMs: 5 }).health())
      .rejects.toMatchObject({ kind: 'timeout' })
  })

  it('surfaces caller cancellation instead of a service failure', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', () => {
      controller.abort(new Error('user cancelled'))
      return Promise.reject(new Error('aborted'))
    })

    const failure = await new ShmGateway(OPTIONS).health(controller.signal).catch((error: unknown) => error)

    expect(failure).not.toBeInstanceOf(ShmError)
    expect(String(failure)).toContain('aborted')
  })

  it('rejects a base URL that cannot address a service', () => {
    expect(() => new ShmGateway({ ...OPTIONS, baseUrl: 'not a url' }))
      .toThrow(/baseUrl is not an absolute URL/)
    expect(() => new ShmGateway({ ...OPTIONS, baseUrl: 'file:///tmp/shm' }))
      .toThrow(/must use http or https/)
  })
})
