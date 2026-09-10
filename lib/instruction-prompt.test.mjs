import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import 'dotenv/config';

const instructionPromptUrl = new URL('../Instruction Prompt.md', import.meta.url);
const instructionPrompt = fs.readFileSync(instructionPromptUrl, 'utf8');
const modes = [
  { name: 'api', heading: 'Hosted/API mode' },
  { name: 'offline', heading: 'Offline mode' },
];
const blockPattern = /^## (Hosted\/API mode|Offline mode)\r?\n\r?\n~~~text\r?\n([\s\S]*?)\r?\n~~~$/gm;
const blocks = [...instructionPrompt.matchAll(blockPattern)].map(([, heading, instructions]) => ({
  heading,
  instructions,
}));

const { buildBombotInstructions } = await import('./openai-responses.ts');

test('Instruction Prompt.md contains exactly one instruction block per OSV mode', () => {
  assert.equal(
    blocks.length,
    modes.length,
    blocks.length < modes.length
      ? `Instruction Prompt.md parse found ${blocks.length} blocks, fewer than ${modes.length} OSV modes`
      : `Instruction Prompt.md parse found ${blocks.length} blocks; expected exactly ${modes.length} OSV modes`,
  );
});

for (const mode of modes) {
  test(`Instruction Prompt.md ${mode.name} block matches shipped instructions byte-for-byte`, () => {
    const matchingBlocks = blocks.filter(block => block.heading === mode.heading);
    assert.equal(
      matchingBlocks.length,
      1,
      `Instruction Prompt.md parse found ${matchingBlocks.length} blocks for OSV mode ${mode.name}`,
    );
    assert.equal(matchingBlocks[0].instructions, buildBombotInstructions(mode.name));
  });
}
