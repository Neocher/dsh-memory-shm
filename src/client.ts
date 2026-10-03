/**
 * HTTP adapter for the SHM (self-evolving hypergraph memory) REST API. Every
 * response crosses a process boundary, so each payload is validated against the
 * subset of the wire document the plugin reads, and every failure is classified
 * so callers can distinguish an unreachable service from a rejected request.
 *
 * @module
 */

import { z as zod } from 'zod'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { HealthOutcome, RecallOutcome, RecalledMemory, WriteOutcome } from './types.ts'

/** Bounded error-body excerpt kept in a failure message. */
const MAX_ERROR_EXCERPT_CHARS = 500

/** How a SHM request failed. */
export type ShmFailureKind = 'timeout' | 'unreachable' | 'http' | 'invalid-response'

/** A failed SHM request, classified by the boundary that rejected it. */
export class ShmError extends Error {
  /** Which failure class this error belongs to. */
  readonly kind: ShmFailureKind
  /** HTTP status when `kind` is `http`. */
  readonly status: number | undefined

  /**
   * @param kind - Failure class.
   * @param message - Model- and log-facing explanation.
   * @param options - HTTP status for `http` failures and the underlying cause.
   */
  constructor(kind: ShmFailureKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ShmError'
    this.kind = kind
    this.status = options.status
  }
}

/** Connection and identity for one SHM service. */
export interface ShmGatewayOptions {
  /** Base URL of the SHM REST service, without a trailing slash requirement. */
  readonly baseUrl: string
  /** Namespace scope for every operation; omitted requests stay service-wide. */
  readonly namespace?: string
  /** Per-request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Bearer token for SHM's file-backed token auth, when the service requires one. */
  readonly token?: string
}

const episodicResultSchema = zod.object({
  node_id: zod.string(),
  content: zod.string().default(''),
  score: zod.number(),
  source: zod.string().optional(),
  tau_value: zod.number().nullish(),
})

const retrieveResponseSchema = zod.object({
  query: zod.string(),
  strategy_used: zod.string().default('auto'),
  results: zod.array(episodicResultSchema).default([]),
  total_found: zod.number().default(0),
  latency_ms: zod.number().default(0),
  degraded: zod.boolean().default(false),
})

const episodeResponseSchema = zod.object({
  episode_id: zod.string(),
  created_at: zod.number(),
  status: zod.string().default('created'),
})

const healthResponseSchema = zod.object({
  status: zod.string(),
  graph_connected: zod.boolean(),
  faiss_loaded: zod.boolean(),
  dream_scheduler_running: zod.boolean().default(false),
  stats: zod.object({
    version: zod.string().optional(),
    node_count: zod.number().optional(),
  }).optional(),
})

/** Adapter for one SHM REST service. All calls are deadline-bounded and cancellation-aware. */
export class ShmGateway {
  readonly #options: ShmGatewayOptions
  readonly #endpoint: URL
  /** Namespace scope spread into every request body, empty when unscoped. */
  readonly #scope: { namespace?: string }

  /**
   * @param options - Service address, namespace, deadline, and optional token.
   * @throws when `baseUrl` is not an absolute http(s) URL.
   */
  constructor(options: ShmGatewayOptions) {
    let endpoint: URL
    try {
      endpoint = new URL(options.baseUrl)
    } catch (error: unknown) {
      throw new Error(`memory-shm: baseUrl is not an absolute URL: ${JSON.stringify(options.baseUrl)}`, { cause: error })
    }
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error(`memory-shm: baseUrl must use http or https, got ${JSON.stringify(endpoint.protocol)}`)
    }
    this.#options = options
    this.#endpoint = endpoint
    this.#scope = options.namespace === undefined ? {} : { namespace: options.namespace }
  }

  /**
   * Retrieve memories matching one query.
   * @param query - Natural-language query text.
   * @param topK - Maximum number of memories the service should return.
   * @param signal - Caller cancellation, fused with the request deadline.
   * @returns Normalized retrieval outcome.
   * @throws {ShmError} when the request times out, cannot connect, is rejected, or returns an unrecognized document.
   */
  async retrieve(query: string, topK: number, signal?: AbortSignal): Promise<RecallOutcome> {
    const payload = await this.#request(
      '/memories/retrieve',
      'POST',
      {},
      {
        query,
        top_k: topK,
        ...this.#scope,
      },
      retrieveResponseSchema,
      signal,
    )
    return {
      query: payload.query,
      strategyUsed: payload.strategy_used,
      totalFound: payload.total_found,
      latencyMs: payload.latency_ms,
      degraded: payload.degraded,
      memories: payload.results.map((row): RecalledMemory => ({
        nodeId: row.node_id,
        content: row.content,
        score: row.score,
        ...(row.source === undefined ? {} : { source: row.source }),
        ...(row.tau_value == null ? {} : { tauValue: row.tau_value }),
      })),
    }
  }

  /**
   * Store one episode in SHM.
   * @param content - Memory text to persist.
   * @param source - Producer attribution recorded by SHM.
   * @param signal - Caller cancellation, fused with the request deadline.
   * @returns The stored episode's identity and status.
   * @throws {ShmError} when the request times out, cannot connect, is rejected, or returns an unrecognized document.
   */
  async writeEpisode(content: string, source: string, signal?: AbortSignal): Promise<WriteOutcome> {
    const payload = await this.#request(
      '/memories/episodes',
      'POST',
      {},
      {
        content,
        source,
        ...this.#scope,
      },
      episodeResponseSchema,
      signal,
    )
    return { episodeId: payload.episode_id, status: payload.status, createdAt: payload.created_at }
  }

  /**
   * Read SHM service health.
   * @param signal - Caller cancellation, fused with the request deadline.
   * @returns Normalized health outcome.
   * @throws {ShmError} when the request times out, cannot connect, is rejected, or returns an unrecognized document.
   */
  async health(signal?: AbortSignal): Promise<HealthOutcome> {
    const payload = await this.#request('/health', 'GET', {}, undefined, healthResponseSchema, signal)
    return {
      healthy: payload.status === 'ok' && payload.graph_connected,
      status: payload.status,
      graphConnected: payload.graph_connected,
      vectorIndexLoaded: payload.faiss_loaded,
      dreamSchedulerRunning: payload.dream_scheduler_running,
      ...(payload.stats?.version === undefined ? {} : { version: payload.stats.version }),
      ...(payload.stats?.node_count === undefined ? {} : { nodeCount: payload.stats.node_count }),
    }
  }

  /** Issue one JSON request under the fused deadline and validate its decoded document. */
  async #request<T>(
    path: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body: unknown,
    schema: zod.ZodType<T>,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    using armed = deadline(signal, this.#options.timeoutMs, `memory-shm:${method} ${path}`)
    const requestHeaders: Record<string, string> = { accept: 'application/json', ...headers }
    if (this.#options.token !== undefined && this.#options.token !== '') {
      requestHeaders.authorization = `Bearer ${this.#options.token}`
    }
    let init: RequestInit = { method, headers: requestHeaders, signal: armed.signal }
    if (body !== undefined) {
      requestHeaders['content-type'] = 'application/json'
      init = { ...init, body: JSON.stringify(body) }
    }
    const url = new URL(path, this.#endpoint)

    let response: Response
    try {
      response = await fetch(url, init)
    } catch (error: unknown) {
      if (timeoutOf(armed.signal) !== undefined) {
        throw new ShmError('timeout', `SHM request ${method} ${path} exceeded ${this.#options.timeoutMs}ms`, { cause: error })
      }
      // An aborted caller signal is cancellation, not a service failure; surface it unchanged.
      if (signal?.aborted === true) throw error
      throw new ShmError('unreachable', `SHM service is unreachable at ${url.origin}: ${String(error)}`, { cause: error })
    }

    if (!response.ok) {
      const excerpt = (await response.text().catch(() => '')).slice(0, MAX_ERROR_EXCERPT_CHARS).trim()
      throw new ShmError(
        'http',
        `SHM ${method} ${path} returned HTTP ${response.status}${excerpt === '' ? '' : `: ${excerpt}`}`,
        { status: response.status },
      )
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      throw new ShmError('invalid-response', `SHM ${method} ${path} returned a body that is not JSON`, { cause: error })
    }
    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new ShmError(
        'invalid-response',
        `SHM ${method} ${path} returned an unrecognized document: ${parsed.error.message}`,
        { cause: parsed.error },
      )
    }
    return parsed.data
  }
}
