/**
 * createAlchemystPlugin
 *
 * The main entry point for `livekit-plugin-alchemyst`.
 *
 * Usage (LiveKit Agents 1.x `Agent` class pattern):
 *
 * ```ts
 * import { createAlchemystPlugin } from 'livekit-plugin-alchemyst';
 * import { Agent, JobContext, WorkerOptions, cli, defineAgent } from '@livekit/agents';
 * import type { ChatContext, ToolContext, ModelSettings } from '@livekit/agents';
 * import * as openai from '@livekit/agents-plugin-openai';
 *
 * const alchemyst = createAlchemystPlugin({ apiKey: process.env.ALCHEMYST_API_KEY });
 *
 * class VoiceAgent extends Agent {
 *   constructor() {
 *     super({
 *       instructions: 'You are a helpful voice assistant.',
 *       llm: new openai.LLM({ model: 'gpt-4o' }),
 *       tools: alchemyst.getTools(),   // remember / recall / forget
 *     });
 *   }
 *
 *   // Intercept llm_node to inject memories before every LLM call
 *   override async llmNode(
 *     chatCtx: ChatContext,
 *     toolCtx: ToolContext,
 *     modelSettings: ModelSettings,
 *   ) {
 *     return alchemyst.createLLMNode(this.llm!)(chatCtx, toolCtx, modelSettings);
 *   }
 * }
 *
 * export default defineAgent({
 *   entry: async (ctx: JobContext) => {
 *     await ctx.connect();
 *     const identity = ctx.room.remoteParticipants.values().next().value?.identity;
 *     alchemyst.bindSession(ctx.room.name, identity);
 *     const agent = new VoiceAgent();
 *     await agent.start(ctx.room).waitForDisconnection();
 *   },
 * });
 * ```
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
  // Primary integration — override llmNode in your Agent subclass
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
