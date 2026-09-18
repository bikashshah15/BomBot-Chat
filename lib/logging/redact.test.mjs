import assert from 'node:assert/strict';
import test from 'node:test';
import { redact, safeValue, errorClass, safeLog } from './redact.ts';

test('P1/P2: all content and unexpected shapes redact by default, including opted-in objects', () => {
  const circular = {}; circular.self = circular;
  for (const value of ['lodash', 'participant message', 'private.json', 'CVE-2099-0001',
    new Error('lodash private.json'), { nested: { message: 'participant' } }, ['lodash'], circular, undefined]) {
    assert.equal(redact(value), '[REDACTED]');
    if (typeof value === 'object' || value === undefined) assert.equal(redact(safeValue(value)), '[REDACTED]');
  }
  assert.equal(redact(safeValue(12)), 12);
  assert.equal(redact(safeValue('upload_failed')), 'upload_failed');
});
test('P3/P5: hostile errors and failed console cannot throw or leak payload', () => {
  const error = new TypeError('participant lodash private.json'); error.name = 'participant'; error.code = 'lodash';
  assert.equal(errorClass(error), 'TypeError');
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  assert.equal(errorClass(proxy.proxy), 'UnknownError');
  assert.equal(redact(proxy.proxy), '[REDACTED]');
  const original = console.error;
  try {
    const lines = []; console.error = (...args) => lines.push(args);
    safeLog('error', safeValue('request_failed'), safeValue(errorClass(error)), error);
    assert.deepEqual(lines, [['request_failed', 'TypeError', '[REDACTED]']]);
    console.error = () => { throw new Error('sink failed'); };
    assert.doesNotThrow(() => safeLog('error', error));
  } finally { console.error = original; }
});
