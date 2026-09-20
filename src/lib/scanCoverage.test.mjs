import assert from 'node:assert/strict';
import test from 'node:test';

import { formatScanCoverageLines } from './scanCoverage.ts';

const ZERO_SKIPS = {
  cap: 0,
  unsupported_purl_type: 0,
  undeterminable_ecosystem: 0,
  unsupported_ecosystem: 0,
};

test('coverage lines report a complete scan without zero-count reasons', () => {
  assert.equal(formatScanCoverageLines({
    totalPackages: 3,
    packagesScanned: 3,
    uniqueScannedPairs: 3,
    skipCounts: ZERO_SKIPS,
  }), [
    '- SBOM entries detected: 3',
    '- Entries vulnerability-scanned: 3 (3 unique package/version pairs)',
    '- Entries not scanned: 0',
  ].join('\n'));
});

test('coverage lines include several nonzero skip categories in stable order', () => {
  assert.equal(formatScanCoverageLines({
    totalPackages: 12,
    packagesScanned: 4,
    uniqueScannedPairs: 4,
    skipCounts: {
      cap: 2,
      unsupported_purl_type: 3,
      undeterminable_ecosystem: 1,
      unsupported_ecosystem: 2,
    },
  }), [
    '- SBOM entries detected: 12',
    '- Entries vulnerability-scanned: 4 (4 unique package/version pairs)',
    '- Entries not scanned: 8 — 2 excluded by the 150-entry scan cap; 3 unsupported package type; 1 ecosystem could not be determined; 2 ecosystem not supported by the scanner',
  ].join('\n'));
});

test('coverage lines use singular package/version pair wording', () => {
  assert.equal(formatScanCoverageLines({
    totalPackages: 2,
    packagesScanned: 1,
    uniqueScannedPairs: 1,
    skipCounts: { ...ZERO_SKIPS, unsupported_purl_type: 1 },
  }), [
    '- SBOM entries detected: 2',
    '- Entries vulnerability-scanned: 1 (1 unique package/version pair)',
    '- Entries not scanned: 1 — 1 unsupported package type',
  ].join('\n'));
});

test('coverage lines handle an SBOM with no scanned entries', () => {
  assert.equal(formatScanCoverageLines({
    totalPackages: 2,
    packagesScanned: 0,
    uniqueScannedPairs: 0,
    skipCounts: { ...ZERO_SKIPS, unsupported_purl_type: 2 },
  }), [
    '- SBOM entries detected: 2',
    '- Entries vulnerability-scanned: 0 (0 unique package/version pairs)',
    '- Entries not scanned: 2 — 2 unsupported package type',
  ].join('\n'));
});

test('coverage lines match the v3.8.3 study SBOM acceptance values', () => {
  assert.equal(formatScanCoverageLines({
    totalPackages: 42,
    packagesScanned: 13,
    uniqueScannedPairs: 6,
    skipCounts: {
      cap: 0,
      unsupported_purl_type: 28,
      undeterminable_ecosystem: 1,
      unsupported_ecosystem: 0,
    },
  }), [
    '- SBOM entries detected: 42',
    '- Entries vulnerability-scanned: 13 (6 unique package/version pairs)',
    '- Entries not scanned: 29 — 28 unsupported package type; 1 ecosystem could not be determined',
  ].join('\n'));
});
