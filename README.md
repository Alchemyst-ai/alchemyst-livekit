# livekit-plugin-alchemyst

A [LiveKit Agents 1.x](https://github.com/livekit/agents) plugin that gives your voice agents **persistent, cross-session memory** powered by [Alchemyst AI](https://platform.getalchemystai.com).

Your agent remembers users across conversations — preferences, past requests, personal details — and uses that context to deliver personalised responses without any manual state management.

---

## Why Use This?

Voice agents are stateless by default. Every new session starts from scratch. This plugin fixes that:

- A user says *"I'm allergic to peanuts"* in session 1 → the agent remembers it in session 47.
- A returning caller doesn't have to repeat their account details.
- The agent builds rapport over time — *"Welcome back! Last time we discussed your trip to Tokyo."*

---

## Features

- **Automatic RAG injection** — relevant memories are semantically retrieved and injected into the chat context before each LLM response, using LiveKit's recommended `onUserTurnCompleted` hook
- **Auto-persist** — completed user/assistant turns are stored to Alchemyst via session events
- **LLM tools** — exposes `remember`, `recall`, and `forget` tools so the model can manage memory explicitly mid-conversation
- **Per-session scoping** — memories are scoped by `groupName`, session ID, and user identity
- **Provider-agnostic** — works with any LLM (OpenAI, Gemini, etc.) via LiveKit Inference or direct plugins
- **Two integration patterns** — simple `onUserTurnCompleted` hook (recommended) or full `llmNode` override (advanced)

---

## Installation

```bash
npm install livekit-plugin-alchemyst
# or
pnpm add livekit-plugin-alchemyst
```

**Peer dependencies** (install separately if not already present):

```bash
npm install @livekit/agents zod
```

---

## Quick Start (Recommended Pattern)

Uses LiveKit's official [`onUserTurnCompleted`](https://docs.livekit.io/agents/logic/external-data/) hook for memory injection. The default pipeline handles all LLM calls — no custom stream wrapping needed.

```ts
import 'dotenv/config';
import { createAlchemystPlugin } from 'livekit-plugin-alchemyst';
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
import * as silero from '@livekit/agents-plugin-silero';

// 1. Create the plugin (shared across all sessions in this worker)
const alchemyst = createAlchemystPlugin({
  apiKey: process.env.ALCHEMYST_API_KEY,
  groupNames: ['voice-agent'],
});

// 2. Define your agent with memory injection
class MyAgent extends voice.Agent {
  constructor() {
    super({
      instructions: 'You are a helpful voice assistant with persistent memory.',
      tools: alchemyst.getTools(), // adds remember / recall / forget
    });
  }

  // Inject relevant memories before the LLM generates a response
  override async onUserTurnCompleted(
    turnCtx: llm.ChatContext,
    newMessage: llm.ChatMessage,
  ): Promise<void> {
    const userText = newMessage.textContent;
    if (!userText) return;

    const memories = await alchemyst.search(userText);
    if (memories.length > 0) {
      turnCtx.addMessage({
        role: 'system',
        content: memories.map((m, i) => `${i + 1}. ${m.content}`).join('\n'),
      });
    }
  }
}

// 3. Wire up the session
export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    // Wait for participant and scope memory to their identity
    let participant = ctx.room.remoteParticipants.values().next().value;
    if (!participant) {
      participant = await new Promise((resolve) => {
        ctx.room.once('participantConnected', resolve);
      });
    }
    alchemyst.bindSession(ctx.room.name!, participant?.identity ?? 'anonymous');

    const session = new voice.AgentSession({
      vad: await silero.VAD.load(),
      stt: new deepgram.STT(),
      tts: new cartesia.TTS(),
      llm: new inference.LLM({ model: 'openai/gpt-4.1-mini' }),
    });

    await session.start({ room: ctx.room, agent: new MyAgent() });

    // Auto-persist completed turns to memory
    let lastUserText: string | null = null;
    session.on('conversation_item_added', (ev) => {
      if (ev.item.role === 'user') {
        lastUserText = ev.item.textContent ?? null;
      } else if (ev.item.role === 'assistant' && lastUserText && ev.item.textContent) {
        alchemyst.addTurn(lastUserText, ev.item.textContent).catch(console.error);
        lastUserText = null;
      }
    });
  },
});
```

See [examples/agent.ts](examples/agent.ts) for the full working example with VAD, turn detection, and the LiveKit CLI bootstrap.

---

## Use Cases

### Customer Support Agent

Remember customer details, past issues, and preferences across calls so users never have to repeat themselves.

```ts
override async onUserTurnCompleted(turnCtx, newMessage) {
  const memories = await alchemyst.search(newMessage.textContent ?? '');
  if (memories.length > 0) {
    turnCtx.addMessage({
      role: 'system',
      content: `Customer history:\n${memories.map(m => m.content).join('\n')}`,
    });
  }
}
```

> *"Hi, I called last week about my billing issue."*
> Agent already knows the ticket number, the plan, and the resolution status.

### Personal AI Companion

Build a voice assistant that learns user preferences, routines, and interests over time.

```ts
const alchemyst = createAlchemystPlugin({
  groupNames: ['companion', 'preferences'],
  maxMemories: 10, // inject more context for personalization
});
```

> *"What should I have for dinner?"*
> Agent remembers you're vegetarian, allergic to nuts, and loved the pasta recipe it suggested last time.

### Sales / Lead Qualification Agent

Track prospect details, past conversations, and buying signals across multiple touchpoints.

```ts
const alchemyst = createAlchemystPlugin({
  groupNames: ['sales', 'prospects'],
  similarityThreshold: 0.6, // cast a wider net for relevant context
});
```

> Prospect calls back a week later — the agent picks up right where the conversation left off, referencing the pricing tier they were interested in.

### Multi-Tenant SaaS Voice Bot

Scope memory per organization and user so tenants never leak data to each other.

```ts
alchemyst.bindSession(
  `org-${orgId}-room-${ctx.room.name}`,  // session scoped to org
  participant.identity,                   // user scoped to participant
);
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `LIVEKIT_URL` | Your LiveKit server URL (`wss://...`) |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `DEEPGRAM_API_KEY` | Deepgram API key (STT) |
| `CARTESIA_API_KEY` | Cartesia API key (TTS) |
| `ALCHEMYST_API_KEY` | Alchemyst AI key — get one at [platform.getalchemystai.com](https://platform.getalchemystai.com) |

> The example uses [LiveKit Inference](https://docs.livekit.io/agents/models/inference/) for the LLM (`inference.LLM`), which routes through LiveKit Cloud and requires no separate OpenAI/Gemini key. To use a direct provider instead, swap in `openai.LLM()` or `google.LLM()` and add the corresponding API key.

---

## Configuration

All options are optional. Pass them to `createAlchemystPlugin(config)`:

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `ALCHEMYST_API_KEY` env | Alchemyst AI API key |
| `userId` | `string` | `"anonymous"` | User identifier (typically participant identity) |
| `sessionId` | `string` | auto-generated | Session identifier (typically room name) |
| `similarityThreshold` | `number` | `0.5` | Cosine similarity threshold for memory retrieval (0–1) |
| `maxMemories` | `number` | `5` | Maximum memories returned per search |
| `groupNames` | `string[]` | `["voice-agent"]` | Group tags for storing and filtering memories |
| `memorySystemPromptTemplate` | `string` | see below | Template for injected memory; use `{{memories}}` placeholder |
| `autoPersist` | `boolean` | `true` | Auto-store turns; set `false` to use the `remember` tool exclusively |
| `logger` | `PluginLogger` | `console` | Custom logger (`info`, `warn`, `error`, `debug`) |

### Default memory template

```
## Relevant memories from previous conversations
The following context was automatically retrieved from long-term memory.
Use it to personalise your responses, but do not mention that you are
using stored memories unless the user explicitly asks.

{{memories}}
```

---

## API Reference

### `createAlchemystPlugin(config?)`

Returns an `AlchemystPluginInstance`:

| Method / Property | Description |
|---|---|
| `bindSession(sessionId, userId?)` | Re-scope memory to a new session and user. Call once per participant. |
| `getTools()` | Returns `remember`, `recall`, `forget` tool definitions for `new Agent({ tools })` |
| `search(query)` | Semantic search over stored memories. Returns `MemoryEntry[]`. |
| `addTurn(userText, assistantText)` | Persist a completed conversation turn to memory. |
| `createLLMNode(llm, opts?)` | *(Advanced)* Returns an `llmNode` function that handles memory injection and persistence internally. |
| `delete(memoryId)` | Delete a specific memory by ID. |
| `deleteSession()` | Delete all memories for the current session. |
| `sessionId` | Current session ID (read-only). |
| `userId` | Current user ID (read-only). |

### LLM Tools

When you pass `alchemyst.getTools()` to your agent, the model gains access to:

| Tool | Parameters | Description |
|---|---|---|
| `remember` | `content`, `tags?` | Store a fact or preference in persistent memory |
| `recall` | `query`, `limit?` | Semantic search over stored memories |
| `forget` | `memoryId` | Permanently delete a memory by ID |

---

## Integration Patterns

### Recommended: `onUserTurnCompleted` hook

The simplest and most robust approach. Memory is injected once per user turn before the default pipeline calls the LLM. Turn persistence is handled via session events.

This is the [official LiveKit RAG pattern](https://docs.livekit.io/agents/logic/external-data/).

### Advanced: `llmNode` override

For full control over the LLM call, use `createLLMNode()` to override the pipeline's `llmNode`. This manages its own `innerLLM.chat()` call, injects memories, wraps the stream, and persists turns internally.

```ts
class AdvancedAgent extends voice.Agent {
  constructor(private myLLM: llm.LLM) {
    super({ instructions: '...', tools: alchemyst.getTools() });
  }

  override async llmNode(chatCtx, toolCtx, modelSettings) {
    return alchemyst.createLLMNode(this.myLLM)(chatCtx, toolCtx, modelSettings);
  }
}
```

> **Note:** When using this pattern, the LLM passed to `AgentSession` is bypassed — make sure to pass the same instance to both, or use the override as the sole LLM entry point.

---

## How It Works

```
User speaks → STT → onUserTurnCompleted (memory search + inject) → LLM → TTS → Agent speaks
                                                                              ↓
                                                              conversation_item_added event
                                                                              ↓
                                                                    addTurn() → Alchemyst API
```

1. **User turn completes** — `onUserTurnCompleted` fires with the transcribed text
2. **Memory search** — the user's utterance is used as a semantic query against stored memories (filtered by `groupName`)
3. **Context injection** — matching memories are added to the chat context as a system message
4. **LLM responds** — the default pipeline calls the LLM with the enriched context
5. **Turn persistence** — the `conversation_item_added` event pairs user + assistant messages and calls `addTurn()` to store them

---

## Running the Example

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# edit .env with your API keys

# 3. Download model files (VAD, turn detection)
npx tsx examples/agent.ts download-files

# 4. Run the agent
npx tsx examples/agent.ts dev
```

Then open the [LiveKit Agents Playground](https://agents-playground.livekit.io/) and connect to your agent.

---

## License

Apache-2.0
