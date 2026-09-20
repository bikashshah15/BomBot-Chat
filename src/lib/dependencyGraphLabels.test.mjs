import assert from 'node:assert/strict';
import test from 'node:test';

import { formatGraphNodeVulnerabilityStatus } from './dependencyGraphLabels.ts';

test('not-scanned nodes show known skip reasons as human-readable text', () => {
  assert.equal(formatGraphNodeVulnerabilityStatus({
    scanned: false,
    vulnerabilityCount: -1,
    skipReason: 'unsupported_purl_type',
  }), 'Not scanned — unsupported package type');
  assert.equal(formatGraphNodeVulnerabilityStatus({
    scanned: false,
    vulnerabilityCount: -1,
    skipReason: 'undeterminable_ecosystem',
  }), 'Not scanned — ecosystem could not be determined');
});

test('not-scanned nodes without a reason use the generic label', () => {
  assert.equal(formatGraphNodeVulnerabilityStatus({
    scanned: false,
    vulnerabilityCount: -1,
  }), 'Not scanned');
});

test('scanned nodes with no findings distinguish a clean scan from not scanned', () => {
  assert.equal(formatGraphNodeVulnerabilityStatus({
    scanned: true,
    vulnerabilityCount: 0,
  }), 'Scanned — no known vulnerabilities found');
});

test('scanned nodes with findings report the known vulnerability count', () => {
  assert.equal(formatGraphNodeVulnerabilityStatus({
    scanned: true,
    vulnerabilityCount: 10,
  }), '10 known vulnerabilities');
});

test('unknown skip reason codes are never displayed to participants', () => {
  assert.equal(formatGraphNodeVulnerabilityStatus({
    scanned: false,
    vulnerabilityCount: -1,
    skipReason: 'future_reason_code',
  }), 'Not scanned');
});
