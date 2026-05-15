export interface ToolMeta {
  name: string;
  hit: boolean;
  latencyMs: number;
}

export interface SemanticMeta {
  hit: boolean;
  similarity?: number;
  savedUsd?: number;
  embedLatencyMs?: number;
  /**
   * Total milliseconds the cache hit took (embedding + lookup + write back).
   * Compared against a recent average for full LLM turns to compute "time
   * saved" without having to call the LLM at all.
   */
  hitLatencyMs?: number;
  /** Confidence of a cache hit: 'high' = well within threshold, 'uncertain' = borderline (judge was or could be applied). */
  confidence?: "high" | "uncertain";
  /** Cosine distance of the nearest neighbour on a miss — shows how close the query came to a hit. */
  nearestMiss?: number;
  /** True when the miss originated from the LLM judge rejecting a hit that cleared the cosine threshold. */
  judgeRejected?: boolean;
  /** True when the LLM judge accepted a borderline hit (score was in the uncertainty band but judge said yes). */
  judgeAccepted?: boolean;
}

export interface TurnMetrics {
  semantic: SemanticMeta;
  toolHits: ToolMeta[];
  llmExactHit?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  savedUsd?: number;
}

export interface GlobalStats {
  totalMessages: number;
  totalSavedUsd: number;
  totalHits: number;
  totalMisses: number;
  hitRate: number;
  /**
   * Total seconds saved by serving from cache instead of running the full
   * LLM + tool pipeline. Measured as `(rolling avg miss latency) - hit
   * latency` per hit, summed.
   */
  totalSavedSeconds: number;
  /** Rolling average of full LLM-turn latency in ms (used for the calculation above). */
  avgMissLatencyMs: number;
}

export interface LogEntry {
  ts: string;
  ip: string;
  q: string;
  semanticHit: boolean;
  toolHits: ToolMeta[];
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  savedUsd?: number;
}
