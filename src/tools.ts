/**
 * Function-tool definitions for explicit LLM memory management.
 *
 * These three tools — `remember`, `recall`, `forget` — are injected into the
 * agent's `tools` option (ToolContext) so the LLM can manage memory
 * programmatically mid-conversation.
 *
 * Usage:
 * ```ts
 * const agent = new Agent({
 *   tools: alchemyst.getTools(),
 * });
 * ```
 *
 * Or merged with your own tools:
 * ```ts
 * const agent = new Agent({
 *   tools: { ...alchemyst.getTools(), ...myTools },
 * });
 * ```
 */

import { llm } from '@livekit/agents';
import { z } from 'zod';
import type { AlchemystMemoryClient } from './memory.js';
import type { RecallResult } from './types.js';

// ---------------------------------------------------------------------------
// Parameter schemas (exported so callers can extend or inspect them)
// ---------------------------------------------------------------------------

export const RememberParams = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      'The fact, preference, or piece of information to remember across future sessions.',
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      'Optional tags / group names for categorising this memory ' +
        '(e.g. ["user-preferences", "q1-2025"]).',
    ),
});

export const RecallParams = z.object({
  query: z
    .string()
    .min(1)
    .describe('Natural-language query to search long-term memory.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Maximum number of results to return (default: 5).'),
});

export const ForgetParams = z.object({
  memoryId: z
    .string()
    .min(1)
    .describe(
      'The ID of the memory to permanently delete, as returned by the `recall` tool.',
    ),
});

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Returns a ToolContext record containing the three Alchemyst tools.
 * Pass directly as (or spread into) the `tools` option of `new Agent(...)`.
 */
export function createAlchemystTools(memory: AlchemystMemoryClient) {
  return {
    // ------------------------------------------------------------------
    remember: llm.tool({
      description:
        'Store a piece of information in persistent memory so it is available ' +
        'in future conversations. Use this when the user shares something ' +
        'important — a preference, a goal, a key fact — that they would expect ' +
        'you to recall later.',
      parameters: RememberParams,
      execute: async ({ content }: z.infer<typeof RememberParams>) => {
        try {
          await memory.add({
            user: content,
            assistant: 'Noted.',
            sessionId: memory.currentSessionId,
          });
          return JSON.stringify({
            success: true,
            message: `Remembered: "${content.slice(0, 100)}${content.length > 100 ? '…' : ''}"`,
          });
        } catch (err) {
          return JSON.stringify({ success: false, error: String(err) });
        }
      },
    }),

    // ------------------------------------------------------------------
    recall: llm.tool({
      description:
        'Search long-term memory for information relevant to a topic or ' +
        'question. Use this when you need context that is not in the current ' +
        'conversation or when the user asks about past interactions.',
      parameters: RecallParams,
      execute: async ({ query, limit }: z.infer<typeof RecallParams>) => {
        const entries = await memory.search(query);
        const sliced = limit ? entries.slice(0, limit) : entries;

        const result: RecallResult =
          sliced.length === 0
            ? { found: false, message: 'No relevant memories found.' }
            : {
                found: true,
                memories: sliced.map((e) => {
                  const entry: { content: string; id?: string; similarity?: number } = {
                    content: e.content,
                  };
                  if (e.memoryId !== undefined) entry.id = e.memoryId;
                  if (e.similarity !== undefined) entry.similarity = e.similarity;
                  return entry as { content: string; similarity?: number };
                }),
              };

        return JSON.stringify(result);
      },
    }),

    // ------------------------------------------------------------------
    forget: llm.tool({
      description:
        'Permanently delete a specific memory. Use this when the user asks ' +
        'you to forget something or when a stored memory is clearly outdated.',
      parameters: ForgetParams,
      execute: async ({ memoryId }: z.infer<typeof ForgetParams>) => {
        try {
          await memory.delete(memoryId);
          return JSON.stringify({
            success: true,
            message: `Memory ${memoryId} has been deleted.`,
          });
        } catch (err) {
          return JSON.stringify({ success: false, error: String(err) });
        }
      },
    }),
  } as const;
}

export type AlchemystFunctionContext = ReturnType<typeof createAlchemystTools>;
