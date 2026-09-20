import assert from 'node:assert/strict';
import test from 'node:test';

import 'dotenv/config';

const { extractSeverity } = await import('./upload.ts');

test('database-specific severity takes precedence over a CVSS vector', () => {
  const severity = extractSeverity({
    database_specific: { severity: 'MODERATE' },
    severity: [{
      type: 'CVSS_V3',
      score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    }],
  });

  assert.equal(severity, 'MODERATE');
});

test('CVSS vectors never fall back to a label scraped from summary text', () => {
  const severity = extractSeverity({
    summary: 'A low severity phrase that is not structured severity data',
    severity: [{
      type: 'CVSS_V3',
      score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    }],
  });

  assert.ok(['CRITICAL', 'Not provided'].includes(severity));
  assert.notEqual(severity, 'LOW');
});

test('summary severity words are not treated as severity data', () => {
  assert.equal(extractSeverity({
    summary: 'A critical workflow can be interrupted',
    details: 'No structured severity was supplied.',
  }), 'Not provided');
});

test('empty or absent structured severity fields return Not provided', () => {
  assert.equal(extractSeverity({}), 'Not provided');
  assert.equal(extractSeverity({ severity: [], database_specific: { severity: '' } }), 'Not provided');
});
