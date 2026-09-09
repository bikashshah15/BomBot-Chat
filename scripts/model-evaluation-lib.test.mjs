import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateScores,
  collapseGuardDecision,
  extractIdentifierOccurrences,
  normalizeIdentifier,
  scoreResponse,
  spearmanCorrelation,
} from './model-evaluation-lib.mjs';

test('collapse guard escalates only at the derived collapse point and tight tolerance', () => {
  const options = { servedContextTokens: 16_384, observedOffsetTokens: 2, tolerance: 1 };
  assert.deepEqual(collapseGuardDecision({ promptTokens: 8194, ...options }), {
    collapseTokens: 8194,
    distance: 0,
    decision: 'escalate',
  });
  assert.equal(collapseGuardDecision({ promptTokens: 8193, ...options }).decision, 'escalate');
  assert.equal(collapseGuardDecision({ promptTokens: 8195, ...options }).decision, 'escalate');
  assert.equal(collapseGuardDecision({ promptTokens: 8192, ...options }).decision, 'pass');
  assert.equal(collapseGuardDecision({ promptTokens: 8290, ...options }).decision, 'pass');
});

const references = [
  {
    identity: 'npm\u0000alpha\u00001.0.0',
    name: 'alpha',
    primaryIds: ['GHSA-1111-2222-3333'],
    referenceSeverity: 4,
    fixedVersions: ['1.0.1'],
  },
  {
    identity: 'npm\u0000beta\u00002.0.0',
    name: 'beta',
    primaryIds: ['GHSA-4444-5555-6666'],
    referenceSeverity: 2,
    fixedVersions: ['2.0.1'],
  },
];

test('model evaluation scoring applies D4 aliases and package-specific mitigation versions', () => {
  const response = [
    'alpha has CRITICAL vulnerability CVE-2099-0001; upgrade alpha to 1.0.1.',
    'beta has LOW vulnerability GHSA-4444-5555-6666; update beta to 9.9.9.',
  ].join('\n');
  const score = scoreResponse({
    response,
    packageReferences: references,
    resolveIdentifier(identifier) {
      if (identifier === 'CVE-2099-0001') return 'GHSA-1111-2222-3333';
      if (identifier === 'GHSA-4444-5555-6666') return identifier;
      return null;
    },
  });

  assert.deepEqual(extractIdentifierOccurrences(response), [
    'CVE-2099-0001',
    'GHSA-4444-5555-6666',
  ]);
  assert.deepEqual(score.fixturePackageClassification, {
    truePositives: 2,
    falsePositives: 0,
    falseNegatives: 0,
  });
  assert.equal(score.identifiers.hallucinated, 0);
  assert.equal(score.identifiers.d4Reclassified, 1);
  assert.deepEqual({
    directMatches: score.identifiers.directMatches,
    aliasResolved: score.identifiers.aliasResolved,
    neither: score.identifiers.neither,
  }, { directMatches: 1, aliasResolved: 1, neither: 0 });
  assert.deepEqual(score.mitigation, { specific: 1, eligible: 2 });
});

test('model evaluation aggregate computes agreement, correlation, and occurrence rates', () => {
  const score = scoreResponse({
    response: [
      'alpha has CRITICAL vulnerability GHSA-1111-2222-3333; fix alpha in 1.0.1.',
      'beta has MODERATE vulnerability CVE-2099-9999; patch beta at 2.0.1.',
    ].join('\n'),
    packageReferences: references,
    resolveIdentifier(identifier) {
      return identifier === 'GHSA-1111-2222-3333' ? identifier : null;
    },
  });
  const aggregate = aggregateScores([score]);

  assert.equal(aggregate.fixturePackageClassificationF1, 1);
  assert.equal(aggregate.severityCorrelation, 1);
  assert.equal(aggregate.severityComparable, 2);
  assert.equal(aggregate.hallucinatedIdentifierRate, 0.5);
  assert.equal(aggregate.mitigationSpecificity, 1);
});

test('direct identifiers are grounded without resolver success and resolution is case-insensitive', () => {
  const direct = scoreResponse({
    response: 'alpha has HIGH vulnerability ghsa-1111-2222-3333.',
    packageReferences: references,
    resolveIdentifier() {
      return null;
    },
  });
  assert.equal(direct.identifiers.directMatches, 1);
  assert.equal(direct.identifiers.aliasResolved, 0);
  assert.equal(direct.identifiers.hallucinated, 0);

  const alias = scoreResponse({
    response: 'alpha has HIGH vulnerability CVE-2099-0001.',
    packageReferences: references,
    resolveIdentifier() {
      return 'ghsa-1111-2222-3333';
    },
  });
  assert.equal(alias.identifiers.directMatches, 0);
  assert.equal(alias.identifiers.aliasResolved, 1);
  assert.equal(alias.identifiers.hallucinated, 0);
  assert.equal(normalizeIdentifier('GhSa-1111-2222-3333'), 'GHSA-1111-2222-3333');
});

test('MAL identifiers are extracted', () => {
  assert.deepEqual(extractIdentifierOccurrences('Found mal-2024-12345.'), ['MAL-2024-12345']);
});

test('fixture-package classification cannot observe an absent package prediction', () => {
  const score = scoreResponse({
    response: 'ghost-package has HIGH vulnerability CVE-2099-9999.',
    packageReferences: references,
    resolveIdentifier() {
      return null;
    },
  });
  assert.deepEqual(score.fixturePackageClassification, {
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 2,
  });
});

test('Spearman correlation is undefined for insufficient or constant ranks', () => {
  assert.equal(spearmanCorrelation([1], [1]), null);
  assert.equal(spearmanCorrelation([1, 1], [1, 2]), null);
});
