import assert from 'node:assert/strict';
import test from 'node:test';

const {
  createTimer,
  formatTimingRecord,
  logTiming,
} = await import('./timing.ts');

test('valid chat and upload timing records serialize with fixed key order (no Postgres)', () => {
  assert.equal(formatTimingRecord({
    kind: 'chat_turn',
    tools_enabled: true,
    outcome: 'completed',
    history_load_ms: 1.4,
    rounds: [{
      db_prep_ms: 2,
      model_first_chunk_ms: 3,
      model_stream_ms: 4,
      db_append_ms: 5,
      input_tokens: 6,
      output_tokens: 7,
      tool_calls_requested: 1,
    }],
    tools: [{ round: 1, tool: 'query_cve_details', ms: 8, ok: true }],
    persist_ms: null,
    total_ms: 9,
  }), '{"event":"timing_v1","kind":"chat_turn","tools_enabled":true,"outcome":"completed","history_load_ms":1,"rounds":[{"db_prep_ms":2,"model_first_chunk_ms":3,"model_stream_ms":4,"db_append_ms":5,"input_tokens":6,"output_tokens":7,"tool_calls_requested":1}],"tools":[{"round":1,"tool":"query_cve_details","ms":8,"ok":true}],"persist_ms":null,"total_ms":9}');

  assert.equal(formatTimingRecord({
    kind: 'upload',
    osv_mode: 'offline',
    outcome: 'ok',
    parse_ms: 10,
    scan_ms: 11,
    persist_ms: 12,
    total_ms: 13,
    packages_scanned: 14,
    packages_total: 15,
  }), '{"event":"timing_v1","kind":"upload","osv_mode":"offline","outcome":"ok","parse_ms":10,"scan_ms":11,"persist_ms":12,"total_ms":13,"packages_scanned":14,"packages_total":15}');
});

test('timing serializer canary input never reaches output (no Postgres)', () => {
  const canaries = [
    'CANARY-participant-text',
    'lodash@4.17.20',
    'pkg:npm/left-pad@1.3.0',
    'CVE-2021-44228',
    '{"package":"x"}',
    'session-7f3c',
  ];
  const record = {
    kind: 'chat_turn',
    tools_enabled: canaries[0],
    outcome: canaries[1],
    history_load_ms: canaries[2],
    rounds: [{
      db_prep_ms: canaries[3],
      model_first_chunk_ms: canaries[4],
      model_stream_ms: canaries[5],
      db_append_ms: { nested: canaries },
      input_tokens: canaries,
      output_tokens: { value: canaries[0] },
      tool_calls_requested: canaries[1],
      [canaries[2]]: canaries[3],
    }],
    tools: [{
      round: canaries[0],
      tool: canaries[1],
      ms: { nested: canaries[2] },
      ok: canaries[3],
      [canaries[4]]: canaries[5],
    }],
    persist_ms: canaries[4],
    total_ms: canaries[5],
    [canaries[0]]: { nested: canaries },
  };

  const output = formatTimingRecord(record);
  assert.doesNotThrow(() => JSON.parse(output));
  assert.equal(JSON.parse(output).invalid, true);
  for (const canary of canaries) assert.equal(output.includes(canary), false);
});

test('invalid numbers and over-cap arrays are dropped and unknown tools are mapped (no Postgres)', () => {
  const invalidUpload = JSON.parse(formatTimingRecord({
    kind: 'upload',
    osv_mode: 'api',
    outcome: 'exception',
    parse_ms: Number.NaN,
    scan_ms: Number.POSITIVE_INFINITY,
    persist_ms: -1,
    total_ms: 86_400_001,
    packages_scanned: 1,
    packages_total: 2,
  }));
  assert.equal(invalidUpload.invalid, true);
  for (const key of ['parse_ms', 'scan_ms', 'persist_ms', 'total_ms']) {
    assert.equal(Object.hasOwn(invalidUpload, key), false);
  }

  const overCap = JSON.parse(formatTimingRecord({
    kind: 'chat_turn',
    tools_enabled: true,
    outcome: 'completed',
    history_load_ms: null,
    rounds: Array.from({ length: 10 }, () => ({})),
    tools: Array.from({ length: 65 }, () => ({})),
    persist_ms: null,
    total_ms: 1,
  }));
  assert.equal(overCap.invalid, true);
  assert.equal(Object.hasOwn(overCap, 'rounds'), false);
  assert.equal(Object.hasOwn(overCap, 'tools'), false);

  const unknownTool = JSON.parse(formatTimingRecord({
    kind: 'chat_turn',
    tools_enabled: true,
    outcome: 'completed',
    history_load_ms: 0,
    rounds: [],
    tools: [{ round: 1, tool: 'not_a_static_tool', ms: 2, ok: false }],
    persist_ms: null,
    total_ms: 3,
  }));
  assert.equal(unknownTool.tools[0].tool, 'unknown');
  assert.equal(unknownTool.invalid, true);

  let clock = 100;
  const timer = createTimer(() => clock);
  const startedAt = timer.start();
  clock = 100_000_100.6;
  assert.equal(timer.since(startedAt), 86_400_000);
  clock = 99;
  assert.equal(timer.since(startedAt), 0);
});

test('logTiming swallows a throwing console.log (no Postgres)', () => {
  const original = console.log;
  console.log = () => { throw new Error('synthetic console failure'); };
  try {
    assert.doesNotThrow(() => logTiming({
      kind: 'upload',
      osv_mode: 'offline',
      outcome: 'ok',
      parse_ms: 1,
      scan_ms: 2,
      persist_ms: 3,
      total_ms: 4,
      packages_scanned: 5,
      packages_total: 6,
    }));
  } finally {
    console.log = original;
  }
});
