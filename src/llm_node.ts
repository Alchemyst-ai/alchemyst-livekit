/**
 * createAlchemystLLMNode (Advanced)
 *
 * Factory that produces a LiveKit Agents `LLMNode` function for users who
 * need full control over the LLM call pipeline.
 *
 * **For most use cases, prefer the `onUserTurnCompleted` hook instead.**
 * See the plugin's main JSDoc or `examples/agent.ts` for the recommended
 * pattern. This module is provided for advanced scenarios where you need
 * to intercept and transform the LLM stream directly.
 *
 * The returned function:
 *  1. Extracts the last user utterance from the ChatContext.
 *  2. Performs an Alchemyst memory recall.
 *  3. Injects relevant memories as a system message at position 0.
 *  4. Calls the inner LLM and pipes its stream through as a ReadableStream.
 *  5. After the stream ends, persists the completed turn (fire-and-forget).
 *
 * Usage inside an Agent subclass:
 *
 * ```ts
 * class VoiceAgent extends voice.Agent {
 *   override async llmNode(chatCtx, toolCtx, modelSettings) {
 *     return alchemyst.createLLMNode(myLLM)(chatCtx, toolCtx, modelSettings);
 *   }
 * }
 * ```
 *
 * **Note:** This approach manages its own `innerLLM.chat()` call — the LLM
 * passed to `AgentSession` is bypassed. Make sure you pass the same LLM
 * instance to both, or use this as the sole LLM entry point.
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


export function getLastUserText(chatCtx: llm.ChatContext): string | null {
  const items = [...chatCtx.items].reverse();
  for (const item of items) {
    if (item.type !== 'message' || item.role !== 'user') continue;
    const text = item.textContent;
    return text !== undefined && text.length > 0 ? text : null;
  }
  return null;
}


export function getLastAssistantText(chatCtx: llm.ChatContext): string | null {
  const items = [...chatCtx.items].reverse();
  for (const item of items) {
    if (item.type !== 'message' || item.role !== 'assistant') continue;
    const text = item.textContent;
    return text !== undefined && text.length > 0 ? text : null;
  }
  return null;
}


function buildMemoryPrompt(memories: string[], template: string): string {
  const numbered = memories.map((m, i) => `${i + 1}. ${m}`).join('\n');
  return template.replace('{{memories}}', numbered);
}


function streamToReadable(
  liveKitStream: llm.LLMStream,
  onComplete: (text: string) => void,
): NodeReadableStream<llm.ChatChunk | string> {
  let accumulated = '';
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    liveKitStream.close();
  };

  return new ReadableStream<llm.ChatChunk | string>({
    async start(controller) {
      try {
        for await (const chunk of liveKitStream) {
          accumulated += chunk.delta?.content ?? '';
          controller.enqueue(chunk);
        }
        controller.close();
        onComplete(accumulated);
      } catch (err) {
        controller.error(err);
      } finally {
        cleanup();
      }
    },
    cancel() {
      cleanup();
    },
  });
}


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
   
    const userText = getLastUserText(chatCtx);

    let enrichedCtx = chatCtx;

    if (userText) {
      try {
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
      } catch (err) {
        log.warn(`[AlchemystPlugin] memory injection skipped — ${String(err)}`);
      }
    }

    const hasTools = Object.keys(toolCtx).length > 0;
    const chatOpts: Parameters<llm.LLM['chat']>[0] = { chatCtx: enrichedCtx };
    if (hasTools) chatOpts.toolCtx = toolCtx;
    if (modelSettings.toolChoice !== undefined) chatOpts.toolChoice = modelSettings.toolChoice;
    const liveKitStream = innerLLM.chat(chatOpts);

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
