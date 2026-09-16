export interface ScanSkipCounts {
  cap: number;
  unsupported_purl_type: number;
  undeterminable_ecosystem: number;
  unsupported_ecosystem: number;
}
export interface CapturedScanSource {
  osv_mode: 'api' | 'offline';
  snapshot_date: string;
  scanned_package_count: number;
  scan_truncated: boolean;
  skip_counts: ScanSkipCounts;
}
/** Whitelist captured results; never infer historical source from config. */
export function readCapturedScanSource(value: unknown): CapturedScanSource | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as CapturedScanSource;
  if (!['api', 'offline'].includes(source.osv_mode)
    || typeof source.snapshot_date !== 'string'
    || !(source.osv_mode === 'api' ? source.snapshot_date === 'not_applicable'
      : /^\d{4}-\d{2}-\d{2}$/u.test(source.snapshot_date))
    || !Number.isSafeInteger(source.scanned_package_count) || source.scanned_package_count < 0
    || typeof source.scan_truncated !== 'boolean' || !source.skip_counts) return null;
  const keys = ['cap', 'unsupported_purl_type', 'undeterminable_ecosystem', 'unsupported_ecosystem'] as const;
  if (keys.some(key => !Number.isSafeInteger(source.skip_counts[key]) || source.skip_counts[key] < 0)) return null;
  return { osv_mode: source.osv_mode, snapshot_date: source.snapshot_date,
    scanned_package_count: source.scanned_package_count, scan_truncated: source.scan_truncated,
    skip_counts: { cap: source.skip_counts.cap, unsupported_purl_type: source.skip_counts.unsupported_purl_type,
      undeterminable_ecosystem: source.skip_counts.undeterminable_ecosystem,
      unsupported_ecosystem: source.skip_counts.unsupported_ecosystem } };
}
