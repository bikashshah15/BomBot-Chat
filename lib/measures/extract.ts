import { readCapturedScanSource } from '../context/scanProvenance.ts';
import type { ScanSkipCounts } from '../context/scanProvenance.ts';
export const REFERENCE_DEFINITION = 'alias-aware-pre-scan-v1';

// Same occurrence grammar as the evaluation harness; repeated link labels and
// destinations count separately. Only assistant text is an emission.
const IDENTIFIERS = /\b(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|(?:PYSEC|RUSTSEC|MAL|GO|OSV|BIT|GSD|EEF-CVE)-\d{4}-\d+)\b/giu;

export interface MeasureMessage {
  role: string;
  content: string;
  pinned: boolean;
  scan_source?: unknown;
}

export interface ScanProvenance {
  osv_mode: 'unknown' | 'api' | 'offline';
  snapshot_date: string;
  scan_truncated: boolean | 'unknown';
  scanned_package_count: number | 'unknown';
  skip_counts?: ScanSkipCounts;
}

export interface ResolutionSource {
  osv_mode: 'offline';
  snapshot_date: string;
  status: 'available' | 'missing_snapshot' | 'pin_mismatch';
}

export interface SessionMeasure {
  reference_definition: typeof REFERENCE_DEFINITION;
  scan_provenance: ScanProvenance[];
  resolution_provenance: ResolutionSource;
  reference_status: 'available' | 'missing_scan' | 'invalid_scan';
  emitted_count: number;
  grounded_count: number;
  ungrounded_count: number;
  unresolved_count: number;
  // Store the completed resolution as categorical outcomes, not advisory IDs:
  // even IDs can reveal the participant's inventory. No future lookup is needed.
  direct_count: number;
  alias_grounded_count: number;
  resolved_ungrounded_count: number;
  not_found_count: number;
}

export interface LocalResolution {
  source: ResolutionSource;
  primaryByIdentifier: Map<string, string>;
}

export interface ExtractionDependencies {
  readMessages(sessionId: string): Promise<MeasureMessage[]>;
  resolveLocally(identifiers: string[]): Promise<LocalResolution>;
  store(sessionId: string, measure: SessionMeasure): Promise<void>;
}

function reference(messages: MeasureMessage[]) {
  const ids = new Set<string>();
  const provenance: ScanProvenance[] = [];
  let invalid = false;
  const marker = '**Minimized Software Context:**\n';
  for (const message of messages) {
    if (!message.pinned || message.role !== 'user') continue;
    const start = message.content.indexOf(marker);
    if (start === -1) continue;
    try {
      // The upload producer serializes the context on one line. Do not parse
      // arbitrary participant JSON or infer a source from today's config.
      const context = JSON.parse(message.content.slice(start + marker.length).split('\n')[0]);
      if (!Array.isArray(context.packages_depends_on)) throw new Error('Invalid scan');
      for (const pkg of context.packages_depends_on) {
        if (!Array.isArray(pkg.vulnerabilities)) throw new Error('Invalid scan');
        for (const vulnerability of pkg.vulnerabilities) {
          if (typeof vulnerability.id !== 'string') throw new Error('Invalid scan');
          ids.add(vulnerability.id.toUpperCase());
        }
      }
      const captured = readCapturedScanSource(message.scan_source);
      provenance.push(captured ?? {
        osv_mode: 'unknown', snapshot_date: 'unknown',
        scan_truncated: typeof context.scan_truncated === 'boolean' ? context.scan_truncated : 'unknown',
        scanned_package_count: Number.isSafeInteger(context.scanned_package_count)
          && context.scanned_package_count >= 0 ? context.scanned_package_count : 'unknown',
      });
    } catch {
      invalid = true;
      provenance.push({ osv_mode: 'unknown', snapshot_date: 'unknown',
        scan_truncated: 'unknown', scanned_package_count: 'unknown' });
    }
  }
  if (provenance.length === 0) provenance.push({ osv_mode: 'unknown', snapshot_date: 'unknown',
    scan_truncated: 'unknown', scanned_package_count: 'unknown' });
  const status = invalid ? 'invalid_scan' : messages.some(message => message.pinned
    && message.role === 'user' && message.content.includes(marker)) ? 'available' : 'missing_scan';
  return { ids, provenance, status } as const;
}

/** Callable only: INC-12c-3 will invoke this before destroying a session key. */
export async function extractSessionMeasures(
  sessionId: string,
  dependencies: ExtractionDependencies,
): Promise<SessionMeasure> {
  const messages = await dependencies.readMessages(sessionId);
  const scan = reference(messages);
  const emissions = messages.filter(message => message.role === 'assistant')
    .flatMap(message => [...message.content.matchAll(IDENTIFIERS)].map(match => match[0].toUpperCase()));
  const resolution = await dependencies.resolveLocally([...new Set(emissions)]);
  const measure: SessionMeasure = {
    reference_definition: REFERENCE_DEFINITION,
    scan_provenance: scan.provenance,
    resolution_provenance: resolution.source,
    reference_status: scan.status,
    emitted_count: emissions.length, grounded_count: 0, ungrounded_count: 0,
    unresolved_count: 0, direct_count: 0, alias_grounded_count: 0,
    resolved_ungrounded_count: 0, not_found_count: 0,
  };
  for (const identifier of emissions) {
    const primary = resolution.primaryByIdentifier.get(identifier);
    if (scan.status !== 'available') {
      measure.unresolved_count++;
    } else if (scan.ids.has(identifier)) {
      measure.direct_count++;
      measure.grounded_count++;
    } else if (resolution.source.status !== 'available') {
      measure.unresolved_count++;
    } else if (primary && scan.ids.has(primary.toUpperCase())) {
      measure.alias_grounded_count++;
      measure.grounded_count++;
    } else {
      measure.ungrounded_count++;
      if (primary) measure.resolved_ungrounded_count++;
      else measure.not_found_count++;
    }
  }
  await dependencies.store(sessionId, measure);
  return measure;
}
