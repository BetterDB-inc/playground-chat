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
