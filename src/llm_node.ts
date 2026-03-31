/**
 * createAlchemystLLMNode
 *
 * Factory that produces a LiveKit Agents `LLMNode` function.
 *
 * The returned function:
 *  1. Extracts the last user utterance from the ChatContext.
 *  2. Performs an Alchemyst memory recall in parallel with (or before) the
 *     LLM call.
 *  3. Injects relevant memories as a scoped system message, inserted at
 *     position 0 so the model sees it at the start of the context window.
 *  4. Calls the inner LLM and pipes its stream through as a ReadableStream.
 *  5. After the stream ends, asynchronously persists the completed
 *     user/assistant turn (fire-and-forget; errors are logged, never thrown).
 *
 * Usage inside an Agent subclass:
 *
 * ```ts
 * import { voice } from '@livekit/agents';
 * import type { ChatContext, ToolContext, ModelSettings } from '@livekit/agents/llm';
 *
 * class VoiceAgent extends Agent {
 *   override async llmNode(
 *     chatCtx: ChatContext,
 *     toolCtx: ToolContext,
 *     modelSettings: ModelSettings,
 *   ) {
 *     return this.plugin.createLLMNode(this.llm!)(chatCtx, toolCtx, modelSettings);
 *   }
 * }
 * ```
 */

import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { llm } from '@livekit/agents';
import type { AlchemystMemoryClient } from './memory.js';
import { MEMORY_SYSTEM_PROMPT_TEMPLATE, type PluginLogger } from './types.js';


export type LLMNodeFunc = (
  chatCtx: llm.ChatContext,
  toolCtx: llm.ToolContext,
  modelSettings: { toolChoice?: llm.ToolChoice },
) => Promise<NodeReadableStream<llm.ChatChunk | string> | null>;

export interface LLMNodeOptions {
  /** Override the memory system prompt template for this node only. */
  memorySystemPromptTemplate?: string;
  /** Auto-persist completed turns. Inherits plugin config when not set. */
  autoPersist?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the text content of the most recent user message, or `null` if none.
 */
export function getLastUserText(chatCtx: llm.ChatContext): string | null {
  const items = [...chatCtx.items].reverse();
  for (const item of items) {
    if (item.type !== 'message' || item.role !== 'user') continue;
    const text = item.textContent;
    return text !== undefined && text.length > 0 ? text : null;
  }
  return null;
}

/**
 * Return the text content of the most recent assistant message, or `null`.
 */
export function getLastAssistantText(chatCtx: llm.ChatContext): string | null {
  const items = [...chatCtx.items].reverse();
  for (const item of items) {
    if (item.type !== 'message' || item.role !== 'assistant') continue;
    const text = item.textContent;
    return text !== undefined && text.length > 0 ? text : null;
  }
  return null;
}

/**
 * Build the memory system prompt from the template and an ordered list of
 * memory content strings.
 */
function buildMemoryPrompt(memories: string[], template: string): string {
  const numbered = memories.map((m, i) => `${i + 1}. ${m}`).join('\n');
  return template.replace('{{memories}}', numbered);
}

/**
 * Convert an LLMStream (AsyncIterableIterator<ChatChunk>) to a Web API
 * ReadableStream<ChatChunk | string>, accumulating text for persistence.
 */
function streamToReadable(
  liveKitStream: llm.LLMStream,
  onComplete: (text: string) => void,
): NodeReadableStream<llm.ChatChunk | string> {
  const iter: AsyncIterator<llm.ChatChunk> = liveKitStream[Symbol.asyncIterator]();
  let accumulated = '';
  let finished = false;

  return new ReadableStream<llm.ChatChunk | string>({
    async pull(controller) {
      if (finished) return;
      try {
        const result = await iter.next();
        if (result.done) {
          finished = true;
          controller.close();
          onComplete(accumulated);
        } else {
          // Accumulate text delta
          accumulated += result.value.delta?.content ?? '';
          controller.enqueue(result.value);
        }
      } catch (err) {
        finished = true;
        controller.error(err);
      }
    },
    cancel() {
      finished = true;
      iter.return?.();
    },
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAlchemystLLMNode(
  innerLLM: llm.LLM,
  memory: AlchemystMemoryClient,
  opts: {
    memorySystemPromptTemplate?: string;
    autoPersist?: boolean;
    log: PluginLogger;
  },
): LLMNodeFunc {
  const template = opts.memorySystemPromptTemplate ?? MEMORY_SYSTEM_PROMPT_TEMPLATE;
  const autoPersist = opts.autoPersist ?? true;
  const log = opts.log;

  return async (
    chatCtx: llm.ChatContext,
    toolCtx: llm.ToolContext,
    modelSettings: { toolChoice?: llm.ToolChoice },
  ): Promise<NodeReadableStream<llm.ChatChunk | string> | null> => {
    // ------------------------------------------------------------------
    // 1. Extract last user utterance
    // ------------------------------------------------------------------
    const userText = getLastUserText(chatCtx);

    // ------------------------------------------------------------------
    // 2. Recall + inject memories
    // ------------------------------------------------------------------
    let enrichedCtx = chatCtx;

    if (userText) {
      const memories = await memory.search(userText);

      if (memories.length > 0) {
        const systemText = buildMemoryPrompt(
          memories.map((m) => m.content),
          template,
        );

        enrichedCtx = chatCtx.copy();
        // Insert with createdAt: 0 so it sorts to position 0 —
        // before the agent instructions and conversation history.
        enrichedCtx.insert(
          llm.ChatMessage.create({
            role: 'system',
            content: systemText,
            createdAt: 0,
          }),
        );

        log.debug(
          `[AlchemystPlugin] injected ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} into llmNode`,
        );
      }
    }

    // ------------------------------------------------------------------
    // 3. Call the inner LLM
    // ------------------------------------------------------------------
    const hasTools = Object.keys(toolCtx).length > 0;
    const chatOpts: Parameters<llm.LLM['chat']>[0] = { chatCtx: enrichedCtx };
    if (hasTools) chatOpts.toolCtx = toolCtx;
    if (modelSettings.toolChoice !== undefined) chatOpts.toolChoice = modelSettings.toolChoice;
    const liveKitStream = innerLLM.chat(chatOpts);

    // ------------------------------------------------------------------
    // 4. Pipe through a ReadableStream, collecting text for persistence
    // ------------------------------------------------------------------
    const readable = streamToReadable(liveKitStream, (assistantText) => {
      if (autoPersist && userText && assistantText) {
        memory
          .add({
            user: userText,
            assistant: assistantText,
            sessionId: memory.currentSessionId,
          })
          .catch((err) =>
            log.error(
              `[AlchemystPlugin] failed to persist turn — ${String(err)}`,
            ),
          );
      }
    });

    return readable;
  };
}
