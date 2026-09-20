interface GraphNodeVulnerabilityStatus {
  scanned?: boolean;
  vulnerabilityCount: number;
  skipReason?: string;
}

const SKIP_REASON_LABELS: Readonly<Record<string, string>> = {
  unsupported_purl_type: 'unsupported package type',
  undeterminable_ecosystem: 'ecosystem could not be determined',
};

export function formatGraphNodeVulnerabilityStatus(
  node: GraphNodeVulnerabilityStatus,
): string {
  const scanned = node.scanned ?? node.vulnerabilityCount >= 0;
  if (!scanned) {
    const reason = node.skipReason ? SKIP_REASON_LABELS[node.skipReason] : undefined;
    return reason ? `Not scanned — ${reason}` : 'Not scanned';
  }

  if (node.vulnerabilityCount === 0) {
    return 'Scanned — no known vulnerabilities found';
  }

  return `${node.vulnerabilityCount} known vulnerabilities`;
}
