/**
 * Configuration for the AlchemystPlugin.
 */
export interface AlchemystPluginConfig {
  /** Alchemyst AI API key. Falls back to ALCHEMYST_API_KEY env var. */
  apiKey?: string;

  /**
   * User identifier — typically the LiveKit participant identity.
   * Used together with `sessionId` to scope memories.
   * Defaults to `"anonymous"`.
   */
  userId?: string;

  /**
   * Session identifier — typically the LiveKit room name.
   * Defaults to an auto-generated ID; pass a stable value (e.g. room name)
   * to persist context across reconnects within the same session.
   */
  sessionId?: string;

  /**
   * Cosine-similarity threshold for memory retrieval.
   * Range 0–1; higher values return only highly relevant memories.
   * @default 0.7
   */
  similarityThreshold?: number;

  /**
   * Maximum number of memories injected into the system prompt each turn.
   * @default 5
   */
  maxMemories?: number;

  /**
   * Alchemyst groupName taxonomy applied when storing memories.
   * Follows the recommended 3-layer hierarchy (org / category / specifics).
   * @default ["voice-agent"]
   */
  groupNames?: string[];

  /**
   * Handlebars-style template for the injected memory system message.
   * Available variable: `{{memories}}` — newline-joined memory strings.
   * @default see MEMORY_SYSTEM_PROMPT_TEMPLATE
   */
  memorySystemPromptTemplate?: string;

  /**
   * Automatically persist each completed user/assistant turn to Alchemyst.
   * Disable if you prefer to call `remember()` explicitly via the tool.
   * @default true
   */
  autoPersist?: boolean;

  /** Optional logger; defaults to `console`. */
  logger?: PluginLogger;
}

export interface PluginLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

/** A single memory entry returned from Alchemyst context search. */
export interface MemoryEntry {
  content: string;
  memoryId?: string;
  similarity?: number;
  metadata?: Record<string, unknown>;
}

/** A completed conversation turn to be persisted. */
export interface ConversationTurn {
  user: string;
  assistant: string;
  sessionId: string;
}

/**
 * Return type from the `recall` function tool.
 * Serialised to JSON before being returned to the LLM.
 */
export interface RecallResult {
  found: boolean;
  memories?: Array<{ content: string; similarity?: number }>;
  message?: string;
}

export const MEMORY_SYSTEM_PROMPT_TEMPLATE = `\
## Relevant memories from previous conversations
The following context was automatically retrieved from long-term memory.
Use it to personalise your responses, but do not mention that you are
using stored memories unless the user explicitly asks.

{{memories}}`;
