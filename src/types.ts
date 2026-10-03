/**
 * Domain types for the SHM-backed memory plugin. The gateway normalizes the
 * SHM HTTP wire format into these values before any tool or recall path sees
 * it, so consumers never read snake_case wire fields.
 *
 * @module
 */

/** One memory the SHM service matched for a query. */
export interface RecalledMemory {
  /** Stable node id inside SHM, usable in later audit reads. */
  readonly nodeId: string
  /** The stored memory text, unmodified. */
  readonly content: string
  /** SHM relevance score for this query; higher ranks first. */
  readonly score: number
  /** The producer recorded by SHM, when it reports one. */
  readonly source?: string
  /** Learnable temporal-decay value at retrieval time, when SHM reports one. */
  readonly tauValue?: number
}

/** One completed retrieval. */
export interface RecallOutcome {
  /** The query as sent. */
  readonly query: string
  /** The retrieval strategy SHM actually used, such as `auto` or `hybrid`. */
  readonly strategyUsed: string
  /** How many memories SHM matched, before the plugin's own presentation cap. */
  readonly totalFound: number
  /** Server-side retrieval time in milliseconds. */
  readonly latencyMs: number
  /** True when SHM fell back to its degraded path for this query. */
  readonly degraded: boolean
  /** Matching memories in SHM's ranking order. */
  readonly memories: readonly RecalledMemory[]
}

/** One completed episode write. */
export interface WriteOutcome {
  /** SHM's id for the stored episode. */
  readonly episodeId: string
  /** SHM's write status, such as `created` or `quarantined`. */
  readonly status: string
  /** Unix epoch milliseconds SHM recorded for the write. */
  readonly createdAt: number
}

/** SHM service health as reported to the model. */
export interface HealthOutcome {
  /** True when the graph backend is connected and the vector index is loaded. */
  readonly healthy: boolean
  /** SHM's own status string. */
  readonly status: string
  /** Whether the graph backend answers. */
  readonly graphConnected: boolean
  /** Whether the vector index is loaded. */
  readonly vectorIndexLoaded: boolean
  /** Whether SHM's dream (consolidation) scheduler is running. */
  readonly dreamSchedulerRunning: boolean
  /** SHM package version, when the health payload carries statistics. */
  readonly version?: string
  /** Number of graph nodes, when the health payload carries statistics. */
  readonly nodeCount?: number
}
