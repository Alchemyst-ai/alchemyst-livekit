/**
 * createAlchemystMemoryClient
 *
 * Wraps the `@alchemystai/sdk` TypeScript SDK and exposes the memory
 * operations needed by the plugin:
 *
 *   - search()        — semantic search over stored context documents
 *   - add()      — persist a completed conversation turn
 *   - deleteMemory()        — delete a memory document by source ID
 *   - deleteSession() — delete all memories for the current session
 *
 * Alchemyst REST endpoints used:
 *   POST /api/v1/context/add    — store a document
 *   POST /api/v1/context/search — semantic search
 *   POST /api/v1/context/delete — delete by source
 */

import type {
  AlchemystPluginConfig,
  ConversationTurn,
  MemoryEntry,
  PluginLogger,
} from './types.js';


interface ContextSearchResult {
  content?: string;
  text?: string;
  similarity?: number;
  similarity_score?: number;
  id?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------

export interface AlchemystMemoryClient {
  readonly currentSessionId: string;
  readonly currentUserId: string;
  search(query: string): Promise<MemoryEntry[]>;
  add(turn: ConversationTurn): Promise<void>;
  delete(memoryIdOrSource: string): Promise<void>;
  deleteSession(): Promise<void>;
}

// ---------------------------------------------------------------------------

export function createAlchemystMemoryClient(
  config: AlchemystPluginConfig,
  sessionId: string,
): AlchemystMemoryClient {
  const apiKey = config.apiKey ??process.env.ALCHEMYST_API_KEY;
  if (!apiKey) {
    throw new Error(
      '[AlchemystPlugin] Missing API key. ' +
        'Pass `apiKey` in AlchemystPluginConfig or set the ALCHEMYST_API_KEY environment variable.',
    );
  }

  // Lazy-loaded SDK instance — initialised on first use via dynamic import().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdk: any = null;
  async function getSDK() {
    if (!sdk) {
      const { AlchemystAI } = await import('@alchemystai/sdk');
      sdk = new AlchemystAI({ apiKey });
    }
    return sdk;
  }

  const userId = config.userId ?? 'anonymous';
  const similarityThreshold = 0.5;
  const maxMemories = config.maxMemories ?? 5;
  const groupNames = config.groupNames ?? ['voice-agent'];
  const log: PluginLogger = config.logger ?? console;

  /** Canonical source identifier for documents stored in this session. */
  const source = `${sessionId}`;

  /** Track whether we've already created the memory document for this session. */
  let memoryInitialised = false;
  /** Running turn counter for unique message IDs within this session. */
  let turnCount = 0;


  async function search(query: string): Promise<MemoryEntry[]> {
    if (!query.trim()) return [];

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = await getSDK();

      // Run both a scoped search (session/user memories) and a general search
      // (directly uploaded context) in parallel, then merge & deduplicate.
      const [scopedRaw, generalRaw]: [any, any] = await Promise.all([
        client.v1.context.search({
          query,
          similarity_threshold: similarityThreshold,
          minimum_similarity_threshold: similarityThreshold,
          mode: 'fast',
          scope: 'internal',
          body_metadata: {
            groupName: [...groupNames, userId],
          },
        }),
        client.v1.context.search({
          query,
          similarity_threshold: similarityThreshold,
          minimum_similarity_threshold: similarityThreshold,
          mode: 'fast',
          scope: 'internal',
        }),
      ]);

      const extractContexts = (raw: any): ContextSearchResult[] =>
        Array.isArray(raw?.contexts)
          ? raw.contexts
          : Array.isArray(raw)
            ? raw
            : [];

      const allContexts = [
        ...extractContexts(scopedRaw),
        ...extractContexts(generalRaw),
      ];

      // Deduplicate by content, keeping the higher-similarity entry
      const seen = new Map<string, ContextSearchResult>();
      for (const ctx of allContexts) {
        const key = ctx.content ?? ctx.text ?? '';
        if (!key) continue;
        const existing = seen.get(key);
        const sim = ctx.similarity ?? ctx.similarity_score ?? 0;
        const existingSim = existing?.similarity ?? existing?.similarity_score ?? 0;
        if (!existing || sim > existingSim) {
          seen.set(key, ctx);
        }
      }

      const entries = [...seen.values()]
        .sort((a, b) => (b.similarity ?? b.similarity_score ?? 0) - (a.similarity ?? a.similarity_score ?? 0))
        .slice(0, maxMemories)
        .map((r): MemoryEntry => {
          const entry: MemoryEntry = { content: r.content ?? r.text ?? '' };
          const memId = r.id ?? r.source;
          if (memId !== undefined) entry.memoryId = memId;
          const sim = r.similarity ?? r.similarity_score;
          if (sim !== undefined) entry.similarity = sim;
          if (r.metadata !== undefined) entry.metadata = r.metadata;
          return entry;
        })
        .filter((e) => e.content.length > 0);

      log.debug(
        `[AlchemystPlugin] recall: ${entries.length} result(s) for "${query.slice(0, 60)}"`,
      );

      return entries;
    } catch (err) {
      log.warn(`[AlchemystPlugin] recall failed — ${String(err)}`);
      return [];
    }
  }


  async function add(turn: ConversationTurn): Promise<void> {
    turnCount++;
    const now = new Date().toISOString();

    const userContent = {
      content: turn.user.trim(),
      role: 'user',
      id: `${sessionId}-turn-${turnCount}-user`,
      createdAt: now,
      metadata: { messageId: `${sessionId}-turn-${turnCount}-user` },
    };
    const assistantContent = {
      content: turn.assistant.trim(),
      role: 'assistant',
      id: `${sessionId}-turn-${turnCount}-assistant`,
      createdAt: now,
      metadata: { messageId: `${sessionId}-turn-${turnCount}-assistant` },
    };

    const client = await getSDK();

    if (!memoryInitialised) {
      // First turn — create the memory document for this session
      await client.v1.context.memory.add({
        sessionId,
        contents: [userContent, assistantContent],
        metadata: {
          groupName: [...groupNames, userId, sessionId],
        },
      });
      memoryInitialised = true;

      log.debug(
        `[AlchemystPlugin] created memory doc — session=${sessionId}, turn=${turnCount}`,
      );
    } else {
      // Subsequent turns — append to the same session document
      await client.v1.context.memory.update({
        sessionId,
        contents: [userContent, assistantContent],
      });

      log.debug(
        `[AlchemystPlugin] updated memory doc — session=${sessionId}, turn=${turnCount}`,
      );
    }
  }


  async function deleteMemory(memoryIdOrSource: string): Promise<void> {
    const client = await getSDK();
    await client.v1.context.memory.delete({
      memoryId: source,
    });

    log.debug(`[AlchemystPlugin] deleted memory — ${memoryIdOrSource}`);
  }

  async function deleteSession(): Promise<void> {
    const client = await getSDK();
    await client.v1.context.memory.delete({
      memoryId: source,
    });

    log.info(
      `[AlchemystPlugin] cleared all memories for session ${sessionId}`,
    );
  }

  // -------------------------------------------------------------------------
  // Return the public API
  // -------------------------------------------------------------------------
  
  return {
    get currentSessionId() { return sessionId; },
    get currentUserId() { return userId; },
    search,
    add,
    delete: deleteMemory,
    deleteSession,
  };
}
