export interface ScanCoverageInput {
  totalPackages: number;
  packagesScanned: number;
  uniqueScannedPairs: number;
  skipCounts: {
    cap: number;
    unsupported_purl_type: number;
    undeterminable_ecosystem: number;
    unsupported_ecosystem: number;
  };
}

const SKIP_REASON_LABELS = [
  ['cap', 'excluded by the 150-entry scan cap'],
  ['unsupported_purl_type', 'unsupported package type'],
  ['undeterminable_ecosystem', 'ecosystem could not be determined'],
  ['unsupported_ecosystem', 'ecosystem not supported by the scanner'],
] as const;

export function formatScanCoverageLines({
  totalPackages,
  packagesScanned,
  uniqueScannedPairs,
  skipCounts,
}: ScanCoverageInput): string {
  const entriesNotScanned = totalPackages - packagesScanned;
  const skipReasons = SKIP_REASON_LABELS
    .filter(([reason]) => skipCounts[reason] > 0)
    .map(([reason, label]) => `${skipCounts[reason]} ${label}`);
  const uniquePairLabel = uniqueScannedPairs === 1 ? 'pair' : 'pairs';
  const reasonSuffix = skipReasons.length > 0 ? ` — ${skipReasons.join('; ')}` : '';

  return [
    `- SBOM entries detected: ${totalPackages}`,
    `- Entries vulnerability-scanned: ${packagesScanned} (${uniqueScannedPairs} unique package/version ${uniquePairLabel})`,
    `- Entries not scanned: ${entriesNotScanned}${reasonSuffix}`,
  ].join('\n');
}
