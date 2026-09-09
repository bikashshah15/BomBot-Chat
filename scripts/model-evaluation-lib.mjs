const IDENTIFIER_PATTERN = /\b(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|(?:PYSEC|RUSTSEC|MAL|GO|OSV|BIT|GSD|EEF-CVE)-\d{4}-\d+)\b/giu;
const SEVERITY_PATTERN = /\b(CRITICAL|HIGH|MODERATE|MEDIUM|LOW)\b/giu;
const HAS_SEVERITY_PATTERN = /\b(?:CRITICAL|HIGH|MODERATE|MEDIUM|LOW)\b/iu;
const RISK_PATTERN = /\b(?:vulnerab\w*|security\s+(?:issue|risk)|affected|exploit\w*)\b/iu;
const MITIGATION_PATTERN = /\b(?:update|upgrade|fix|fixed|patch|patched|remediat\w*|migrat\w*)\b/iu;

export const SEVERITY_RANK = Object.freeze({
  LOW: 1,
  MEDIUM: 2,
  MODERATE: 2,
  HIGH: 3,
  CRITICAL: 4,
});

export function collapseGuardDecision({ promptTokens, servedContextTokens, observedOffsetTokens, tolerance }) {
  const collapseTokens = Math.floor(servedContextTokens / 2) + observedOffsetTokens;
  return {
    collapseTokens,
    distance: promptTokens - collapseTokens,
    decision: Math.abs(promptTokens - collapseTokens) <= tolerance ? 'escalate' : 'pass',
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsExact(value, needle) {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}(?=$|[^\\p{L}\\p{N}_])`, 'iu')
    .test(value);
}

export function responseSegments(response) {
  return response
    .split(/\n+|(?<=[.!?])\s+/u)
    .map(segment => segment.trim())
    .filter(Boolean);
}

export function extractIdentifierOccurrences(response) {
  return [...response.matchAll(IDENTIFIER_PATTERN)].map(match => match[0].toUpperCase());
}

export function normalizeIdentifier(identifier) {
  return identifier.toUpperCase();
}

export function severityRankFromVulnerability(vulnerability) {
  const numericScores = (vulnerability.severity ?? [])
    .map(item => typeof item?.score === 'string' && /^\d+(?:\.\d+)?$/u.test(item.score)
      ? Number(item.score)
      : Number.NaN)
    .filter(Number.isFinite);
  if (numericScores.length > 0) {
    const score = Math.max(...numericScores);
    if (score >= 9) return 4;
    if (score >= 7) return 3;
    if (score >= 4) return 2;
    if (score > 0) return 1;
  }

  const label = typeof vulnerability.database_specific?.severity === 'string'
    ? vulnerability.database_specific.severity.toUpperCase()
    : '';
  return SEVERITY_RANK[label] ?? null;
}

export function fixedVersionsFromVulnerability(vulnerability) {
  return [...new Set((vulnerability.affected ?? [])
    .flatMap(affected => affected.ranges ?? [])
    .flatMap(range => range.events ?? [])
    .flatMap(event => typeof event.fixed === 'string' ? [event.fixed] : []))];
}

export function emittedPackageIdentities(response, packageReferences) {
  const identifiersBySegment = responseSegments(response).map(segment => ({
    segment,
    hasIdentifier: extractIdentifierOccurrences(segment).length > 0,
    hasSeverity: HAS_SEVERITY_PATTERN.test(segment),
  }));
  return new Set(packageReferences.flatMap(packageReference => {
    const emitted = identifiersBySegment.some(({ segment, hasIdentifier, hasSeverity }) => (
      containsExact(segment, packageReference.name)
      && (hasIdentifier || (hasSeverity && RISK_PATTERN.test(segment)))
    ));
    return emitted ? [packageReference.identity] : [];
  }));
}

export function modelSeverityByIdentity(response, packageReferences) {
  const result = new Map();
  const segments = responseSegments(response);
  for (const packageReference of packageReferences) {
    const ranks = segments
      .filter(segment => containsExact(segment, packageReference.name))
      .flatMap(segment => [...segment.matchAll(SEVERITY_PATTERN)]
        .map(match => SEVERITY_RANK[match[1].toUpperCase()]));
    if (ranks.length > 0) result.set(packageReference.identity, Math.max(...ranks));
  }
  return result;
}

export function specificMitigationIdentities(response, packageReferences) {
  const result = new Set();
  const segments = responseSegments(response);
  for (const packageReference of packageReferences) {
    if (packageReference.fixedVersions.length === 0) continue;
    const specific = segments.some(segment => (
      containsExact(segment, packageReference.name)
      && MITIGATION_PATTERN.test(segment)
      && packageReference.fixedVersions.some(version => containsExact(segment, version))
    ));
    if (specific) result.add(packageReference.identity);
  }
  return result;
}

export function averageRanks(values) {
  const sorted = values.map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const ranks = Array(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end += 1;
    const average = ((start + 1) + end) / 2;
    for (let index = start; index < end; index += 1) ranks[sorted[index].index] = average;
    start = end;
  }
  return ranks;
}

export function spearmanCorrelation(referenceValues, modelValues) {
  if (referenceValues.length !== modelValues.length) {
    throw new Error('Spearman inputs must have equal lengths');
  }
  if (referenceValues.length < 2) return null;
  const referenceRanks = averageRanks(referenceValues);
  const modelRanks = averageRanks(modelValues);
  const referenceMean = referenceRanks.reduce((sum, value) => sum + value, 0) / referenceRanks.length;
  const modelMean = modelRanks.reduce((sum, value) => sum + value, 0) / modelRanks.length;
  let numerator = 0;
  let referenceSquares = 0;
  let modelSquares = 0;
  for (let index = 0; index < referenceRanks.length; index += 1) {
    const referenceDelta = referenceRanks[index] - referenceMean;
    const modelDelta = modelRanks[index] - modelMean;
    numerator += referenceDelta * modelDelta;
    referenceSquares += referenceDelta ** 2;
    modelSquares += modelDelta ** 2;
  }
  const denominator = Math.sqrt(referenceSquares * modelSquares);
  return denominator === 0 ? null : numerator / denominator;
}

export function scoreResponse({ response, packageReferences, resolveIdentifier }) {
  const referencePositive = new Set(packageReferences
    .filter(packageReference => packageReference.primaryIds.length > 0)
    .map(packageReference => packageReference.identity));
  const emittedPositive = emittedPackageIdentities(response, packageReferences);
  const truePositives = [...emittedPositive].filter(identity => referencePositive.has(identity)).length;
  const falsePositives = [...emittedPositive].filter(identity => !referencePositive.has(identity)).length;
  const falseNegatives = [...referencePositive].filter(identity => !emittedPositive.has(identity)).length;

  const referencePrimaryIds = new Set(packageReferences
    .flatMap(item => item.primaryIds)
    .map(normalizeIdentifier));
  const emittedIdentifiers = extractIdentifierOccurrences(response);
  const identifierScores = emittedIdentifiers.map(identifier => {
    const resolvedPrimaryId = resolveIdentifier(identifier);
    const normalizedResolvedPrimaryId = typeof resolvedPrimaryId === 'string'
      ? normalizeIdentifier(resolvedPrimaryId)
      : null;
    const directMatch = referencePrimaryIds.has(identifier);
    const aliasResolved = !directMatch
      && normalizedResolvedPrimaryId !== null
      && referencePrimaryIds.has(normalizedResolvedPrimaryId);
    const grounded = directMatch || aliasResolved;
    return {
      identifier,
      resolvedPrimaryId: normalizedResolvedPrimaryId,
      directMatch,
      aliasResolved,
      grounded,
    };
  });

  const modelSeverity = modelSeverityByIdentity(response, packageReferences);
  const severityPairs = packageReferences.flatMap(packageReference => {
    const modelRank = modelSeverity.get(packageReference.identity);
    return packageReference.referenceSeverity !== null && modelRank !== undefined
      ? [{ reference: packageReference.referenceSeverity, model: modelRank }]
      : [];
  });
  const specificMitigations = specificMitigationIdentities(response, packageReferences);
  const eligibleMitigations = packageReferences
    .filter(packageReference => packageReference.primaryIds.length > 0
      && packageReference.fixedVersions.length > 0);

  return {
    fixturePackageClassification: { truePositives, falsePositives, falseNegatives },
    severityPairs,
    identifiers: {
      emitted: identifierScores.length,
      hallucinated: identifierScores.filter(item => !item.grounded).length,
      directMatches: identifierScores.filter(item => item.directMatch).length,
      aliasResolved: identifierScores.filter(item => item.aliasResolved).length,
      neither: identifierScores.filter(item => !item.grounded).length,
      d4Reclassified: identifierScores.filter(item => item.aliasResolved).length,
      occurrences: identifierScores,
    },
    mitigation: {
      specific: eligibleMitigations.filter(item => specificMitigations.has(item.identity)).length,
      eligible: eligibleMitigations.length,
    },
  };
}

export function aggregateScores(scores) {
  const fixturePackageClassification = scores.reduce((total, score) => ({
    truePositives: total.truePositives + score.fixturePackageClassification.truePositives,
    falsePositives: total.falsePositives + score.fixturePackageClassification.falsePositives,
    falseNegatives: total.falseNegatives + score.fixturePackageClassification.falseNegatives,
  }), { truePositives: 0, falsePositives: 0, falseNegatives: 0 });
  const f1Denominator = (2 * fixturePackageClassification.truePositives)
    + fixturePackageClassification.falsePositives + fixturePackageClassification.falseNegatives;
  const fixturePackageClassificationF1 = f1Denominator === 0
    ? 1
    : (2 * fixturePackageClassification.truePositives) / f1Denominator;

  const severityPairs = scores.flatMap(score => score.severityPairs);
  const identifiers = scores.reduce((total, score) => ({
    emitted: total.emitted + score.identifiers.emitted,
    hallucinated: total.hallucinated + score.identifiers.hallucinated,
    directMatches: total.directMatches + score.identifiers.directMatches,
    aliasResolved: total.aliasResolved + score.identifiers.aliasResolved,
    neither: total.neither + score.identifiers.neither,
    d4Reclassified: total.d4Reclassified + score.identifiers.d4Reclassified,
  }), {
    emitted: 0,
    hallucinated: 0,
    directMatches: 0,
    aliasResolved: 0,
    neither: 0,
    d4Reclassified: 0,
  });
  const mitigation = scores.reduce((total, score) => ({
    specific: total.specific + score.mitigation.specific,
    eligible: total.eligible + score.mitigation.eligible,
  }), { specific: 0, eligible: 0 });

  return {
    fixturePackageClassificationF1,
    fixturePackageClassification,
    severityCorrelation: spearmanCorrelation(
      severityPairs.map(pair => pair.reference),
      severityPairs.map(pair => pair.model),
    ),
    severityComparable: severityPairs.length,
    hallucinatedIdentifierRate: identifiers.emitted === 0
      ? null
      : identifiers.hallucinated / identifiers.emitted,
    identifiers,
    mitigationSpecificity: mitigation.eligible === 0
      ? null
      : mitigation.specific / mitigation.eligible,
    mitigation,
  };
}
