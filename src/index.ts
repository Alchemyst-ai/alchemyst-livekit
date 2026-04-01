/**
 * livekit-plugin-alchemyst
 *
 * Integrates the Alchemyst AI context layer into the LiveKit Agents 1.x
 * voice pipeline.  Provides persistent per-session memory that is:
 *
 *  - Automatically recalled and injected before every LLM call.
 *  - Automatically persisted after every completed assistant turn.
 *  - Accessible to the LLM via `remember`, `recall`, and `forget` tools.
 *
 * Quick-start:
 *
 * ```ts
 * import { AlchemystPlugin } from 'livekit-plugin-alchemyst';
 *
 * const alchemyst = new AlchemystPlugin({
 *   apiKey: process.env.ALCHEMYST_API_KEY,
 * });
 *
 * class VoiceAgent extends Agent {
 *   constructor() {
 *     super({
 *       instructions: 'You are a helpful voice assistant.',
 *       llm: new openai.LLM(),
 *       tools: alchemyst.getTools(),
 *     });
 *   }
 *
 *   override llmNode(...args: Parameters<Agent['llmNode']>) {
 *     return alchemyst.createLLMNode(this.llm!)(...args);
 *   }
 * }
 * ```
 *
 * @module livekit-plugin-alchemyst
 */

// Primary export
export { createAlchemystPlugin, type AlchemystPluginInstance } from './plugin.js';

// Memory client (for advanced use / testing)
export { createAlchemystMemoryClient, type AlchemystMemoryClient } from './memory.js';

// LLM-node primitives advance usage
export {
  createAlchemystLLMNode,
  getLastUserText,
  getLastAssistantText,
  type LLMNodeFunc,
  type LLMNodeOptions,
} from './llm_node.js';

// Tool definitions and schemas
export {
  createAlchemystTools,
  RememberParams,
  RecallParams,
  ForgetParams,
  type AlchemystFunctionContext,
} from './tools.js';

// Types
export type {
  AlchemystPluginConfig,
  MemoryEntry,
  ConversationTurn,
  RecallResult,
  PluginLogger,
} from './types.js';

export { MEMORY_SYSTEM_PROMPT_TEMPLATE } from './types.js';
