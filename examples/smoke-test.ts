/**
 * examples/smoke-test.ts
 *
 * Quick smoke test that exercises the Alchemyst memory client directly —
 * no LiveKit server required.
 *
 * Usage:
 *   ALCHEMYST_API_KEY=<your-key> bun run examples/smoke-test.ts
 *   ALCHEMYST_API_KEY=<your-key> npx tsx examples/smoke-test.ts
 */

import { createAlchemystMemoryClient, type AlchemystMemoryClient } from '../src/index.js';

const API_KEY = process.env['ALCHEMYST_API_KEY'];
if (!API_KEY) {
  console.error('Set ALCHEMYST_API_KEY env var before running this test.');
  process.exit(1);
}

const SESSION_ID = `smoke-test-${Date.now()}`;
const USER_ID = 'smoke-test-user';

const memory: AlchemystMemoryClient = createAlchemystMemoryClient(
  {
    apiKey: API_KEY,
    userId: USER_ID,
    groupNames: ['smoke-test'],
    similarityThreshold: 0.5,
    maxMemories: 5,
  },
  SESSION_ID,
);

async function run() {
  console.log(`\n--- Smoke Test ---`);
  console.log(`session : ${memory.currentSessionId}`);
  console.log(`user    : ${memory.currentUserId}\n`);

  // 1. Add a memory
  console.log('[1] Adding a conversation turn...');
  await memory.add({
    user: 'My favourite colour is blue.',
    assistant: 'Got it — blue is your favourite colour!',
    sessionId: SESSION_ID,
  });
  console.log('    ✓ Turn persisted.\n');

  // 2. Search for it
  console.log('[2] Searching for "favourite colour"...');
  const results = await memory.search('favourite colour');
  console.log(`    ✓ Found ${results.length} result(s):`);
  for (const r of results) {
    console.log(`      - [sim=${r.similarity?.toFixed(3) ?? '?'}] ${r.content.slice(0, 100)}`);
  }
  console.log();

  // 3. Add another turn
  console.log('[3] Adding a second turn...');
  await memory.add({
    user: 'I live in San Francisco.',
    assistant: 'Nice — San Francisco is a great city!',
    sessionId: SESSION_ID,
  });
  console.log('    ✓ Second turn persisted.\n');

  // 4. Search for the second turn
  console.log('[4] Searching for "where do I live"...');
  const results2 = await memory.search('where do I live');
  console.log(`    ✓ Found ${results2.length} result(s):`);
  for (const r of results2) {
    console.log(`      - [sim=${r.similarity?.toFixed(3) ?? '?'}] ${r.content.slice(0, 100)}`);
  }
  console.log();

  // 5. Delete the session memories
  console.log('[5] Deleting session memories...');
  await memory.deleteSession();
  console.log('    ✓ Session deleted.\n');

  // 6. Verify deletion
  console.log('[6] Searching again after deletion...');
  const results3 = await memory.search('favourite colour');
  console.log(`    ✓ Found ${results3.length} result(s) (expected 0).\n`);
  for (const r of results3) {
    console.log(`      - [sim=${r.similarity?.toFixed(3) ?? '?'}] ${r.content.slice(0, 100)}`);
  }

  console.log('--- Smoke Test Complete ---\n');
}

run().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
