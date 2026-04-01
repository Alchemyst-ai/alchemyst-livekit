/**
 * examples/agent.ts
 *
 * Full LiveKit Agents 1.x voice assistant with Alchemyst persistent memory.
 *
 * Uses the recommended `onUserTurnCompleted` hook for RAG-style memory
 * injection (see https://docs.livekit.io/agents/logic/external-data/).
 * The default pipeline's `llmNode` handles all LLM calls — no custom
 * stream wrapping needed.
 *
 * Prerequisites
 * -------------
 * 1. Copy .env.example → .env and fill in all API keys.
 * 2. Install dependencies:  pnpm install
 * 3. Run the agent:         npx tsx examples/agent.ts dev
 *
 * Required environment variables:
 *   LIVEKIT_URL             — ws(s)://your-livekit-server
 *   LIVEKIT_API_KEY         — LiveKit API key
 *   LIVEKIT_API_SECRET      — LiveKit API secret
 *   DEEPGRAM_API_KEY        — Nova-2 STT key
 *   CARTESIA_API_KEY        — Cartesia TTS key
 *   ALCHEMYST_API_KEY       — Alchemyst Platform key (platform.getalchemystai.com)
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import {
  type JobContext,
  cli,
  defineAgent,
  inference,
  ServerOptions,
  voice,
  llm,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as cartesia from '@livekit/agents-plugin-cartesia';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as silero from '@livekit/agents-plugin-silero';
// Import from the local source (change to 'livekit-plugin-alchemyst' when
// consuming as a published package)
import { createAlchemystPlugin } from '../src/index.js';

// ---------------------------------------------------------------------------
// 1. Create the plugin once at module load time.
//    All agent sessions in this worker share the same plugin instance.
//    Each session calls alchemyst.bindSession() to get its own memory scope.
// ---------------------------------------------------------------------------

const alchemyst = createAlchemystPlugin({
  similarityThreshold: 0.5,
  maxMemories: 6,
  groupNames: ['voice-agent', 'demo'],
  autoPersist: true,
});

// ---------------------------------------------------------------------------
// 2. Define the Agent subclass with onUserTurnCompleted for memory injection
// ---------------------------------------------------------------------------

class AlchemystAgent extends voice.Agent {
  constructor() {
    super({
      instructions: `\
You are a friendly and helpful voice assistant with persistent memory across sessions.

When relevant context from previous conversations is provided in your system prompt,
use it naturally to personalise your responses. Do not explicitly mention that you
are consulting stored memories unless the user asks.

You have access to three memory management tools:
- Call "remember" to explicitly store something the user tells you.
- Call "recall" when you need to search memory mid-conversation.
- Call "forget" to delete a memory the user asks you to remove.`,
      tools: alchemyst.getTools(),
    });
  }

  /**
   * Inject relevant memories into the chat context before the LLM generates
   * a response. This is the official LiveKit RAG pattern — runs once per
   * user turn, avoids custom stream wrapping, and lets the default llmNode
   * handle all LLM calls and tool orchestration.
   */
  override async onUserTurnCompleted(
    turnCtx: llm.ChatContext,
    newMessage: llm.ChatMessage,
  ): Promise<void> {
    const userText = newMessage.textContent;
    if (!userText) return;

    try {
      const memories = await alchemyst.search(userText);
      if (memories.length > 0) {
        const memoryText = memories
          .map((m, i) => `${i + 1}. ${m.content}`)
          .join('\n');
        turnCtx.addMessage({
          role: 'system',
          content: [
            'Relevant context from previous conversations:',
            memoryText,
          ].join('\n'),
        });
      }
    } catch (err) {
      console.warn('[AlchemystAgent] memory lookup failed:', err);
    }
  }

  override async onEnter(): Promise<void> {
    this.session.generateReply({
      instructions: 'Greet the user with a warm welcome.',
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Entry point
// ---------------------------------------------------------------------------

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    // Wait for a remote participant so we can read their identity.
    // When using the LiveKit Playground, the participant may not be in
    // remoteParticipants yet at connect time.
    let participant = ctx.room.remoteParticipants.values().next().value;
    if (!participant) {
      participant = await new Promise<any>((resolve) => {
        ctx.room.once('participantConnected', resolve);
      });
    }
    const identity: string = participant?.identity ?? 'anonymous';
    const sessionId = ctx.room.name ?? ' ';

    alchemyst.bindSession(sessionId, identity);

    console.info(
      `[agent] connected — room=${ctx.room.name} identity=${identity} session=${sessionId}`,
    );

    const vad = await silero.VAD.load();
    const agent = new AlchemystAgent();

    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT(),
      tts: new cartesia.TTS(),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
      turnHandling: {
        turnDetection: new livekit.turnDetector.MultilingualModel(),
      },
    });

    await session.start({
      room: ctx.room,
      agent,
    });

    // -----------------------------------------------------------------------
    // Auto-persist completed turns to Alchemyst memory.
    // The pipeline emits 'conversation_item_added' for every user and
    // assistant message committed to the chat context. We pair them up
    // and persist each completed turn.
    // -----------------------------------------------------------------------
    let lastUserText: string | null = null;

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const msg = ev.item;
      if (msg.role === 'user') {
        lastUserText = msg.textContent ?? null;
      } else if (msg.role === 'assistant' && lastUserText) {
        const assistantText = msg.textContent;
        if (assistantText) {
          const userText = lastUserText;
          lastUserText = null;
          alchemyst.addTurn(userText, assistantText).catch((err) =>
            console.error('[agent] failed to persist turn:', err),
          );
        }
      }
    });

    console.info('[agent] session started');
  },
});

// ---------------------------------------------------------------------------
// 4. Bootstrap — start the LiveKit Agents CLI / server
// ---------------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: import.meta.filename }));
}
