/**
 * examples/agent.ts
 *
 * Full LiveKit Agents 1.x voice assistant with Alchemyst persistent memory.
 *
 * Prerequisites
 * -------------
 * 1. Copy .env.example → .env and fill in all API keys.
 * 2. Install dependencies:  bun install
 * 3. Run the agent:         bun run examples/agent.ts dev
 *    or:                    npx tsx examples/agent.ts dev
 *
 * Required environment variables:
 *   LIVEKIT_URL             — ws(s)://your-livekit-server
 *   LIVEKIT_API_KEY         — LiveKit API key
 *   LIVEKIT_API_SECRET      — LiveKit API secret
 *   OPENAI_API_KEY          — GPT-4o key
 *   DEEPGRAM_API_KEY        — Nova-2 STT key
 *   ELEVENLABS_API_KEY      — ElevenLabs TTS key
 *   ALCHEMYST_API_KEY       — Alchemyst Platform key (platform.getalchemystai.com)
 */

import type { ReadableStream } from 'stream/web';
import {
  type JobContext,
  defineAgent,
  voice,
  llm,
} from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import * as livekit from '@livekit/agents-plugin-livekit';
import * as openai from '@livekit/agents-plugin-openai';
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
  // apiKey defaults to process.env.ALCHEMYST_API_KEY
  similarityThreshold: 0.72,
  maxMemories: 6,
  groupNames: ['voice-agent', 'demo'],
  autoPersist: true,
});

// ---------------------------------------------------------------------------
// 2. Define the Agent subclass with memory-augmented llmNode
// ---------------------------------------------------------------------------

class AlchemystAgent extends voice.Agent {
  private sessionLLM: llm.LLM;

  constructor(sessionLLM: llm.LLM) {
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
    this.sessionLLM = sessionLLM;
  }

  override async llmNode(
    chatCtx: llm.ChatContext,
    toolCtx: llm.ToolContext,
    modelSettings: voice.ModelSettings,
  ): Promise<ReadableStream<llm.ChatChunk | string> | null> {
    return alchemyst.createLLMNode(this.sessionLLM)(chatCtx, toolCtx, modelSettings);
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

    // Scope memory to the specific user so different participants don't share
    // the same memory silo.
    const participant = ctx.room.remoteParticipants.values().next().value;
    const identity: string = participant?.identity ?? 'anonymous';
    const sessionId = ctx.room.name ?? ' ';

    alchemyst.bindSession(sessionId, identity);

    console.info(
      `[agent] connected — room=${ctx.room.name} identity=${identity} session=${sessionId}`,
    );

    // Load VAD and create the LLM instance
    const vad = await silero.VAD.load();
    const sessionLLM = new openai.responses.LLM();

    const agent = new AlchemystAgent(sessionLLM as unknown as llm.LLM);

    const session = new voice.AgentSession({
      vad,
      stt: new deepgram.STT(),
      tts: new elevenlabs.TTS(),
      llm: sessionLLM,
      turnHandling: {
        turnDetection: new livekit.turnDetector.MultilingualModel(),
      },
    });

    await session.start({
      room: ctx.room,
      agent,
    });

    console.info('[agent] session started');
  },
});
