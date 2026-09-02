export class OSVSourceUnavailableError extends Error {
  constructor() {
    super('OSV vulnerability source is unavailable');
    this.name = 'OSVSourceUnavailableError';
  }
}

export class MissingOSVSnapshotDateError extends Error {
  constructor() {
    super('OSV_SNAPSHOT_DATE must be set before running osv:sync');
    this.name = 'MissingOSVSnapshotDateError';
  }
}

export class OSVSnapshotDateMismatchError extends Error {
  constructor(snapshotDate: string, maxModified: string) {
    super(`OSV_SNAPSHOT_DATE ${snapshotDate} predates max_modified ${maxModified}`);
    this.name = 'OSVSnapshotDateMismatchError';
  }
}

export class OSVDroppedAdvisoryThresholdError extends Error {
  constructor(
    droppedCount: number,
    recordCount: number,
    threshold: number,
    ecosystem?: string,
  ) {
    super(
      `OSV${ecosystem ? ` ${ecosystem}` : ''} dropped-advisory rate ${droppedCount}/${recordCount} exceeds threshold ${threshold}`,
    );
    this.name = 'OSVDroppedAdvisoryThresholdError';
  }
}

export class OSVScannerExecutionError extends Error {
  constructor(exitCode: number | string | null) {
    super(`osv-scanner --offline failed with exit code ${String(exitCode)}`);
    this.name = 'OSVScannerExecutionError';
  }
}

export class OSVScannerOutputError extends Error {
  constructor() {
    super('osv-scanner --offline returned invalid JSON output');
    this.name = 'OSVScannerOutputError';
  }
}

export class OSVMatcherSnapshotDisagreementError extends Error {
  constructor(missingIds: string[]) {
    super(`osv-scanner matched IDs absent from osv_vulns: ${missingIds.join(', ')}`);
    this.name = 'OSVMatcherSnapshotDisagreementError';
  }
}

export class OSVPackageVersionRequiredError extends Error {
  constructor() {
    super('Offline OSV matching requires a package version');
    this.name = 'OSVPackageVersionRequiredError';
  }
}
