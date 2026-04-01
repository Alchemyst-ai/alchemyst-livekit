/**
 * createAlchemystPlugin
 *
 * The main entry point for `livekit-plugin-alchemyst`.
 *
 * ## Recommended: `onUserTurnCompleted` pattern (RAG injection)
 *
 * ```ts
 * import { createAlchemystPlugin } from 'livekit-plugin-alchemyst';
 * import { defineAgent, inference, voice, llm } from '@livekit/agents';
 *
 * const alchemyst = createAlchemystPlugin({ apiKey: process.env.ALCHEMYST_API_KEY });
 *
 * class MyAgent extends voice.Agent {
 *   constructor() {
 *     super({
 *       instructions: 'You are a helpful voice assistant.',
 *       tools: alchemyst.getTools(),
 *     });
 *   }
 *
 *   override async onUserTurnCompleted(
 *     turnCtx: llm.ChatContext,
 *     newMessage: llm.ChatMessage,
 *   ): Promise<void> {
 *     const userText = newMessage.textContent;
 *     if (!userText) return;
 *     const memories = await alchemyst.search(userText);
 *     if (memories.length > 0) {
 *       turnCtx.addMessage({
 *         role: 'system',
 *         content: memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n'),
 *       });
 *     }
 *   }
 * }
 *
 * export default defineAgent({
 *   entry: async (ctx) => {
 *     await ctx.connect();
 *     alchemyst.bindSession(ctx.room.name!, participant.identity);
 *     const session = new voice.AgentSession({
 *       llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
 *     });
 *     await session.start({ room: ctx.room, agent: new MyAgent() });
 *
 *     // Auto-persist turns
 *     let lastUserText: string | null = null;
 *     session.on('conversation_item_added', (ev) => {
 *       if (ev.item.role === 'user') lastUserText = ev.item.textContent ?? null;
 *       else if (ev.item.role === 'assistant' && lastUserText && ev.item.textContent) {
 *         alchemyst.addTurn(lastUserText, ev.item.textContent).catch(console.error);
 *         lastUserText = null;
 *       }
 *     });
 *   },
 * });
 * ```
 *
 * ## Alternative: `llmNode` override (advanced)
 *
 * For full control over the LLM call, use `createLLMNode()` to override
 * the pipeline's `llmNode`. This manages its own LLM stream and handles
 * both memory injection and turn persistence internally.
 * See {@link createAlchemystLLMNode} in `llm_node.ts` for details.
 */

import { llm } from '@livekit/agents';
import { createAlchemystMemoryClient, type AlchemystMemoryClient } from './memory.js';
import {
  createAlchemystLLMNode,
  type LLMNodeFunc,
  type LLMNodeOptions,
} from './llm_node.js';
import { createAlchemystTools, type AlchemystFunctionContext } from './tools.js';
import {
  MEMORY_SYSTEM_PROMPT_TEMPLATE,
  type AlchemystPluginConfig,
  type PluginLogger,
} from './types.js';


export interface AlchemystPluginInstance {
  /** Re-scope memory to a specific session and user. */
  bindSession(sessionId: string, userId?: string): void;
  sessionId: string;
  userId: string;
  /** Returns an LLMNode function for use in Agent.llmNode override. */
  createLLMNode(innerLLM: llm.LLM, opts?: LLMNodeOptions): LLMNodeFunc;
  getTools(): AlchemystFunctionContext;
  search(query: string): ReturnType<AlchemystMemoryClient['search']>;
  /** Persist a completed user/assistant turn to memory. */
  addTurn(userText: string, assistantText: string): Promise<void>;
  delete(memoryIdOrSource: string): Promise<void>;
  deleteSession(): Promise<void>;
}

export function createAlchemystPlugin(
  config: AlchemystPluginConfig = {},
): AlchemystPluginInstance {
  const log: PluginLogger = config.logger ?? console;
  const resolvedMemoryTemplate =
  config.memorySystemPromptTemplate ?? MEMORY_SYSTEM_PROMPT_TEMPLATE;
  const resolvedAutoPersist = config.autoPersist ?? true;

  const initialSessionId = config.sessionId ?? generateSessionId();
  let memory = createAlchemystMemoryClient(config, initialSessionId);

  log.info(
    `[AlchemystPlugin] initialised — session=${initialSessionId}, user=${config.userId ?? 'anonymous'}`,
  );

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------

  function bindSession(sessionId: string, userId?: string): void {
    const updatedConfig: AlchemystPluginConfig = {
      ...config,
      sessionId,
      ...(userId !== undefined ? { userId } : {}),
    };
    memory = createAlchemystMemoryClient(updatedConfig, sessionId);
    log.info(
      `[AlchemystPlugin] session rebound — session=${sessionId}, user=${userId ?? 'unchanged'}`,
    );
  }

  // -------------------------------------------------------------------------
  // LLM node override (advanced — most users should use onUserTurnCompleted)
  // -------------------------------------------------------------------------

  function makeLLMNode(innerLLM: llm.LLM, opts: LLMNodeOptions = {}): LLMNodeFunc {
    return createAlchemystLLMNode(innerLLM, memory, {
      memorySystemPromptTemplate:
        opts.memorySystemPromptTemplate ?? resolvedMemoryTemplate,
      autoPersist: opts.autoPersist ?? resolvedAutoPersist,
      log,
    });
  }


  function getTools(): AlchemystFunctionContext {
    return createAlchemystTools(memory);
  }

  async function search(query: string) {
    return memory.search(query);
  }

  async function addTurn(userText: string, assistantText: string) {
    return memory.add({
      user: userText,
      assistant: assistantText,
      sessionId: memory.currentSessionId,
    });
  }

  async function deleteMemory(memoryIdOrSource: string) {
    return memory.delete(memoryIdOrSource);
  }

  async function deleteSession() {
    return memory.deleteSession();
  }

  // -------------------------------------------------------------------------
  // Return the public API object
  // -------------------------------------------------------------------------

  return {
    bindSession,
    get sessionId() {
      return memory.currentSessionId;
    },
    get userId() {
      return memory.currentUserId;
    },
    createLLMNode: makeLLMNode,
    getTools,
    search,
    addTurn,
    delete: deleteMemory,
    deleteSession,
  };
}

// ---------------------------------------------------------------------------

function generateSessionId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 9);
  return `alchemyst-${ts}-${rnd}`;
}


