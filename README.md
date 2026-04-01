# livekit-plugin-alchemyst

A [LiveKit Agents 1.x](https://github.com/livekit/agents) plugin that integrates [Alchemyst AI](https://platform.getalchemystai.com) persistent memory into voice agent pipelines.

Memories are automatically recalled before every LLM call and persisted after every completed turn — with no changes to your agent's core logic beyond a two-line override.

---

## Features

- **Auto-recall** — relevant memories are semantically retrieved and injected into the system prompt before each LLM call
- **Auto-persist** — each completed user/assistant turn is stored to Alchemyst after the response
- **LLM tools** — exposes `remember`, `recall`, and `forget` tools so the model can manage memory mid-conversation
- **Per-session scoping** — memories are scoped by session ID and user identity, so different participants never share memory
- **Zero-friction setup** — one `createAlchemystPlugin()` call and a single `llmNode` override

---

## Installation

```bash
npm install livekit-plugin-alchemyst
# or
bun add livekit-plugin-alchemyst
```

**Peer dependencies** (install separately if not already present):

```bash
npm install @livekit/agents zod
```

---

## Quick Start

```ts
import { createAlchemystPlugin } from 'livekit-plugin-alchemyst';
import {
  type JobContext,
  defineAgent,
  voice,
  llm,
} from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';

// 1. Create the plugin once at module load time
const alchemyst = createAlchemystPlugin({
  apiKey: process.env.ALCHEMYST_API_KEY,
});

// 2. Subclass Agent, inject tools and override llmNode
class VoiceAgent extends voice.Agent {
  constructor(private sessionLLM: llm.LLM) {
    super({
      instructions: 'You are a helpful voice assistant.',
      tools: alchemyst.getTools(), // adds remember / recall / forget
    });
  }

  override async llmNode(
    chatCtx: llm.ChatContext,
    toolCtx: llm.ToolContext,
    modelSettings: voice.ModelSettings,
  ) {
    return alchemyst.createLLMNode(this.sessionLLM)(chatCtx, toolCtx, modelSettings);
  }
}

// 3. Bind a session per connected participant
export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const identity = ctx.room.remoteParticipants.values().next().value?.identity ?? 'anonymous';
    alchemyst.bindSession(ctx.room.name, identity);

    const sessionLLM = new openai.responses.LLM();
    const agent = new VoiceAgent(sessionLLM as unknown as llm.LLM);
    // ... start your AgentSession
  },
});
```

See [examples/agent.ts](examples/agent.ts) for a complete working example with Deepgram STT, ElevenLabs TTS, and Silero VAD.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Description |
|---|---|
| `LIVEKIT_URL` | Your LiveKit server URL (`wss://...`) |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `OPENAI_API_KEY` | OpenAI API key (for GPT-4o) |
| `DEEPGRAM_API_KEY` | Deepgram API key (for STT) |
| `ELEVENLABS_API_KEY` | ElevenLabs API key (for TTS) |
| `ALCHEMYST_API_KEY` | Alchemyst AI key — get one at [platform.getalchemystai.com](https://platform.getalchemystai.com) |

---

## Configuration

All options are optional. Pass them to `createAlchemystPlugin(config)`:

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `ALCHEMYST_API_KEY` env var | Alchemyst AI API key |
| `userId` | `string` | `"anonymous"` | User identifier (typically participant identity) |
| `sessionId` | `string` | auto-generated | Session identifier (typically room name) |
| `similarityThreshold` | `number` | `0.7` | Cosine similarity threshold for memory retrieval (0–1) |
| `maxMemories` | `number` | `5` | Maximum memories injected into the system prompt per turn |
| `groupNames` | `string[]` | `["voice-agent"]` | Alchemyst group taxonomy tags applied when storing memories |
| `memorySystemPromptTemplate` | `string` | see below | Handlebars-style template; use `{{memories}}` as the placeholder |
| `autoPersist` | `boolean` | `true` | Auto-store each completed turn; set to `false` to use the `remember` tool exclusively |
| `logger` | `PluginLogger` | `console` | Custom logger (`info`, `warn`, `error`, `debug`) |

### Default memory system prompt template

```
## Relevant memories from previous conversations
The following context was automatically retrieved from long-term memory.
Use it to personalise your responses, but do not mention that you are
using stored memories unless the user explicitly asks.

{{memories}}
```

---

## API

### `createAlchemystPlugin(config?)`

Returns an `AlchemystPluginInstance` with these methods:

| Method | Description |
|---|---|
| `bindSession(sessionId, userId?)` | Re-scope memory to a new session/user (call once per incoming participant) |
| `createLLMNode(llm, opts?)` | Returns an `llmNode`-compatible function that injects memory before the LLM call and persists the turn after |
| `getTools()` | Returns the `remember`, `recall`, and `forget` tool definitions for use in `new Agent({ tools: ... })` |
| `search(query)` | Programmatically search memory |
| `delete(memoryId)` | Delete a specific memory by ID |
| `deleteSession()` | Delete all memories for the current session |

### LLM Tools

When you pass `alchemyst.getTools()` to your agent, the model gains access to:

| Tool | Description |
|---|---|
| `remember(content, tags?)` | Store a fact or preference in persistent memory |
| `recall(query, limit?)` | Semantic search over stored memories |
| `forget(memoryId)` | Permanently delete a memory by ID |

---

## Running the Example

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp .env.example .env
# edit .env with your keys

# 3. Run
bun run example
# or
npx tsx examples/agent.ts dev
```

---

## License

Apache-2.0
