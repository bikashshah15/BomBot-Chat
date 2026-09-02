import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, opendir, readFile, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import {
  clearOsvSnapshot,
  insertOsvAdvisoryRows,
  insertOsvSnapshot,
  insertOsvVulnerabilityRows,
  type OsvAdvisoryRow,
  type OsvQueryClient,
  type OsvVulnerabilityRow,
} from './db.ts';
import { OSV_ECOSYSTEMS, type OsvEcosystem } from './ecosystems.ts';
import {
  OSVDroppedAdvisoryThresholdError,
  OSVSnapshotDateMismatchError,
} from './errors.ts';

const execFileAsync = promisify(execFile);
const OSV_BUCKET_PATH = 'osv-vulnerabilities';
export const MAX_DROPPED_ADVISORY_RATE = 0.0025;
export const MAX_DROPPED_ADVISORY_SAMPLES = 20;

export type OsvDroppedAdvisoryReason =
  | 'affected_not_array'
  | 'affected_empty'
  | 'ecosystem_mismatch'
  | 'invalid_package_name';

export interface OsvDroppedAdvisorySample {
  id: string;
  reason: OsvDroppedAdvisoryReason;
  observedEcosystems: string[];
}

export type OsvDroppedReasonCounts = Record<OsvDroppedAdvisoryReason, number>;

interface OsvAffectedPackage {
  package?: { ecosystem?: unknown; name?: unknown };
  ranges?: unknown[];
  versions?: unknown[];
}

interface OsvRecord {
  id?: unknown;
  aliases?: unknown;
  modified?: unknown;
  summary?: unknown;
  severity?: unknown;
  database_specific?: unknown;
  affected?: unknown;
}

interface DownloadedArchive {
  ecosystem: OsvEcosystem;
  archivePath: string;
  sourceUrl: string;
  size: number;
}

export interface OsvSyncSummary {
  snapshotDate: string;
  ingestedAt: string;
  maxModified: string;
  sourceUrl: string;
  ecosystemRecordCounts: Record<string, number>;
  ecosystemDroppedCounts: Record<string, number>;
  ecosystemDroppedReasonCounts: Record<string, OsvDroppedReasonCounts>;
  ecosystemDroppedSamples: Record<string, OsvDroppedAdvisorySample[]>;
  downloadedBytes: number;
  workDirectory: string;
  downloadsRetained: boolean;
  scannerDatabaseDirectory: string;
}

export interface OsvSyncOptions {
  mirrorBaseUrl: string;
  snapshotDate: string;
  scannerCacheDirectory: string;
  keepDownloads?: boolean;
  fetchImplementation?: typeof fetch;
  onProgress?: (message: string) => void;
}

async function publishScannerDatabases(
  archives: DownloadedArchive[],
  cacheDirectory: string,
  snapshotDate: string,
) {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const stagingDirectory = await mkdtemp(path.join(cacheDirectory, '.staging-'));
  const publishedDirectory = path.join(cacheDirectory, snapshotDate);
  const previousDirectory = `${publishedDirectory}.previous-${process.pid}`;
  let previousMoved = false;

  try {
    for (const archive of archives) {
      // OSV-Scanner 2.5.x delegates matching to OSV-Scalibr and reads this layout.
      const ecosystemDirectory = path.join(stagingDirectory, 'osv-scalibr', archive.ecosystem);
      await mkdir(ecosystemDirectory, { recursive: true, mode: 0o700 });
      await copyFile(archive.archivePath, path.join(ecosystemDirectory, 'all.zip'));
    }

    try {
      await rename(publishedDirectory, previousDirectory);
      previousMoved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    try {
      await rename(stagingDirectory, publishedDirectory);
    } catch (error) {
      if (previousMoved) await rename(previousDirectory, publishedDirectory).catch(() => {});
      throw error;
    }

    if (previousMoved) await rm(previousDirectory, { recursive: true, force: true });
    return publishedDirectory;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

export function assertSafeArchiveEntries(entries: string[]) {
  if (entries.length === 0) {
    throw new Error('OSV archive contains no entries');
  }

  for (const entry of entries) {
    const segments = entry.replace(/\\/g, '/').split('/');
    if (
      entry.includes('\0')
      || path.posix.isAbsolute(entry)
      || path.win32.isAbsolute(entry)
      || segments.includes('..')
    ) {
      throw new Error(`Unsafe OSV archive entry: ${JSON.stringify(entry)}`);
    }
  }
}

export function osvRowsFromRecord(record: OsvRecord, expectedEcosystem: OsvEcosystem) {
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new Error(`OSV ${expectedEcosystem} record is missing an id`);
  }
  if (typeof record.modified !== 'string' || Number.isNaN(Date.parse(record.modified))) {
    throw new Error(`OSV record ${record.id} has an invalid modified timestamp`);
  }
  if (!Array.isArray(record.affected)) {
    return [];
  }

  const rows = new Map<string, OsvVulnerabilityRow>();
  for (const affected of record.affected as OsvAffectedPackage[]) {
    const ecosystem = affected?.package?.ecosystem;
    const packageName = affected?.package?.name;
    if (
      typeof ecosystem !== 'string'
      || baseOsvEcosystem(ecosystem) !== expectedEcosystem
      || typeof packageName !== 'string'
      || packageName.length === 0
    ) {
      continue;
    }

    const rowKey = JSON.stringify([ecosystem, packageName]);
    const existing = rows.get(rowKey);
    const existingRangeData = existing?.ranges as { ranges: unknown[]; versions: unknown[] } | undefined;
    const rangeData = {
      ranges: [
        ...(existingRangeData?.ranges ?? []),
        ...(Array.isArray(affected.ranges) ? affected.ranges : []),
      ],
      versions: [
        ...(existingRangeData?.versions ?? []),
        ...(Array.isArray(affected.versions) ? affected.versions : []),
      ],
    };

    rows.set(rowKey, {
      id: record.id,
      ecosystem,
      packageName,
      ranges: rangeData,
      severity: record.severity ?? null,
      databaseSpecific: record.database_specific ?? null,
      aliases: record.aliases ?? null,
      summary: typeof record.summary === 'string' ? record.summary : null,
      modified: record.modified,
    });
  }

  return [...rows.values()];
}

export function baseOsvEcosystem(ecosystem: string) {
  const separator = ecosystem.indexOf(':');
  return separator === -1 ? ecosystem : ecosystem.slice(0, separator);
}

export function osvIngestResultFromRecord(record: OsvRecord, expectedEcosystem: OsvEcosystem) {
  const rows = osvRowsFromRecord(record, expectedEcosystem);
  let droppedSample: OsvDroppedAdvisorySample | null = null;

  if (rows.length === 0) {
    // Drop-reason precedence is intentionally most-specific-first:
    // affected_not_array > affected_empty > invalid_package_name > ecosystem_mismatch.
    if (!Array.isArray(record.affected)) {
      droppedSample = {
        id: record.id as string,
        reason: 'affected_not_array',
        observedEcosystems: [],
      };
    } else if (record.affected.length === 0) {
      droppedSample = {
        id: record.id as string,
        reason: 'affected_empty',
        observedEcosystems: [],
      };
    } else {
      const observedEcosystems = [...new Set(
        (record.affected as OsvAffectedPackage[])
          .map(affected => affected?.package?.ecosystem)
          .filter((ecosystem): ecosystem is string => typeof ecosystem === 'string'),
      )].sort();
      const hasExpectedEcosystem = (record.affected as OsvAffectedPackage[])
        .some(affected => (
          typeof affected?.package?.ecosystem === 'string'
          && baseOsvEcosystem(affected.package.ecosystem) === expectedEcosystem
        ));
      droppedSample = {
        id: record.id as string,
        reason: hasExpectedEcosystem ? 'invalid_package_name' : 'ecosystem_mismatch',
        observedEcosystems,
      };
    }
  }

  return {
    rows,
    dropped: rows.length === 0,
    droppedSample,
    modified: record.modified as string,
  };
}

export function appendDroppedAdvisorySample(
  samples: OsvDroppedAdvisorySample[],
  sample: OsvDroppedAdvisorySample | null,
) {
  if (sample && samples.length < MAX_DROPPED_ADVISORY_SAMPLES) {
    samples.push(sample);
  }
}

export function createDroppedReasonCounts(): OsvDroppedReasonCounts {
  return {
    affected_not_array: 0,
    affected_empty: 0,
    ecosystem_mismatch: 0,
    invalid_package_name: 0,
  };
}

export function incrementDroppedReasonCount(
  counts: OsvDroppedReasonCounts,
  sample: OsvDroppedAdvisorySample,
) {
  counts[sample.reason] += 1;
}

export function assertDroppedAdvisoryRateWithinLimit(
  ecosystemRecordCounts: Record<string, number>,
  ecosystemDroppedCounts: Record<string, number>,
) {
  for (const [ecosystem, recordCount] of Object.entries(ecosystemRecordCounts)) {
    const droppedCount = ecosystemDroppedCounts[ecosystem] ?? 0;
    if (recordCount > 0 && droppedCount / recordCount > MAX_DROPPED_ADVISORY_RATE) {
      throw new OSVDroppedAdvisoryThresholdError(
        droppedCount,
        recordCount,
        MAX_DROPPED_ADVISORY_RATE,
        ecosystem,
      );
    }
  }

  const recordCount = Object.values(ecosystemRecordCounts)
    .reduce((total, count) => total + count, 0);
  const droppedCount = Object.values(ecosystemDroppedCounts)
    .reduce((total, count) => total + count, 0);

  if (recordCount > 0 && droppedCount / recordCount > MAX_DROPPED_ADVISORY_RATE) {
    throw new OSVDroppedAdvisoryThresholdError(
      droppedCount,
      recordCount,
      MAX_DROPPED_ADVISORY_RATE,
    );
  }
}

export function assertSnapshotDateCoversMaxModified(snapshotDate: string, maxModified: string) {
  const maxModifiedDate = new Date(maxModified).toISOString().slice(0, 10);
  if (snapshotDate < maxModifiedDate) {
    throw new OSVSnapshotDateMismatchError(snapshotDate, maxModified);
  }
}

async function runUnzip(arguments_: string[]) {
  return execFileAsync('unzip', arguments_, { maxBuffer: 64 * 1024 * 1024 });
}

async function verifyArchive(archivePath: string) {
  await runUnzip(['-tqq', archivePath]);

  const listing = await runUnzip(['-Z1', archivePath]);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  assertSafeArchiveEntries(entries);

  const detailedListing = await runUnzip(['-Z', '-l', archivePath]);
  if (detailedListing.stdout.split(/\r?\n/).some(line => line.startsWith('l'))) {
    throw new Error('OSV archive contains a symbolic link');
  }
}

async function downloadArchive(
  ecosystem: OsvEcosystem,
  mirrorBaseUrl: string,
  workDirectory: string,
  fetchImplementation: typeof fetch,
) {
  const sourceUrl = `${mirrorBaseUrl}/${OSV_BUCKET_PATH}/${encodeURIComponent(ecosystem)}/all.zip`;
  const response = await fetchImplementation(sourceUrl, { redirect: 'error' });
  if (!response.ok || !response.body) {
    throw new Error(`OSV archive download failed for ${ecosystem}: HTTP ${response.status}`);
  }

  const archivePath = path.join(workDirectory, `${ecosystem.replace(/[^A-Za-z0-9.-]/g, '_')}-all.zip`);
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
  );

  const archiveSize = (await stat(archivePath)).size;
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) !== archiveSize) {
    throw new Error(
      `OSV archive length mismatch for ${ecosystem}: expected ${declaredLength}, received ${archiveSize}`,
    );
  }
  if (archiveSize === 0) {
    throw new Error(`OSV archive for ${ecosystem} is empty`);
  }

  await verifyArchive(archivePath);
  return { ecosystem, archivePath, sourceUrl, size: archiveSize } satisfies DownloadedArchive;
}

async function* jsonFiles(directory: string): AsyncGenerator<string> {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* jsonFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      yield entryPath;
    }
  }
}

async function ingestArchive(client: OsvQueryClient, archive: DownloadedArchive, workDirectory: string) {
  const extractDirectory = path.join(workDirectory, `extracted-${archive.ecosystem.replace(/[^A-Za-z0-9.-]/g, '_')}`);
  await runUnzip(['-qq', archive.archivePath, '-d', extractDirectory]);

  let recordCount = 0;
  let droppedCount = 0;
  let rowCount = 0;
  let maxModified: string | undefined;
  const droppedSamples: OsvDroppedAdvisorySample[] = [];
  const droppedReasonCounts = createDroppedReasonCounts();
  let pendingAdvisories: OsvAdvisoryRow[] = [];
  let pendingRows: OsvVulnerabilityRow[] = [];
  for await (const filePath of jsonFiles(extractDirectory)) {
    const record = JSON.parse(await readFile(filePath, 'utf8')) as OsvRecord;
    const ingestResult = osvIngestResultFromRecord(record, archive.ecosystem);
    pendingAdvisories.push({
      id: record.id as string,
      aliases: record.aliases ?? null,
      record,
    });
    pendingRows.push(...ingestResult.rows);
    recordCount += 1;
    rowCount += ingestResult.rows.length;
    if (ingestResult.dropped) {
      droppedCount += 1;
      appendDroppedAdvisorySample(droppedSamples, ingestResult.droppedSample);
      incrementDroppedReasonCount(droppedReasonCounts, ingestResult.droppedSample!);
    }
    if (!maxModified || Date.parse(ingestResult.modified) > Date.parse(maxModified)) {
      maxModified = ingestResult.modified;
    }

    if (pendingRows.length >= 500) {
      await insertOsvVulnerabilityRows(client, pendingRows);
      pendingRows = [];
    }
    if (pendingAdvisories.length >= 500) {
      await insertOsvAdvisoryRows(client, pendingAdvisories);
      pendingAdvisories = [];
    }
  }

  await insertOsvAdvisoryRows(client, pendingAdvisories);
  await insertOsvVulnerabilityRows(client, pendingRows);
  if (recordCount === 0) {
    throw new Error(`OSV archive for ${archive.ecosystem} contains no JSON records`);
  }
  if (rowCount === 0) {
    throw new Error(`OSV archive for ${archive.ecosystem} produced no vulnerability rows`);
  }
  return {
    recordCount,
    droppedCount,
    droppedReasonCounts,
    droppedSamples,
    maxModified: maxModified!,
  };
}

export async function syncOsvSnapshot(client: OsvQueryClient, options: OsvSyncOptions) {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'bombot-osv-sync-'));
  const archives: DownloadedArchive[] = [];
  let transactionStarted = false;

  try {
    for (const ecosystem of OSV_ECOSYSTEMS) {
      options.onProgress?.(`Downloading and verifying OSV ${ecosystem} archive`);
      archives.push(await downloadArchive(
        ecosystem,
        options.mirrorBaseUrl,
        workDirectory,
        fetchImplementation,
      ));
    }

    await client.query('BEGIN');
    transactionStarted = true;
    await clearOsvSnapshot(client);

    const ecosystemRecordCounts: Record<string, number> = {};
    const ecosystemDroppedCounts: Record<string, number> = {};
    const ecosystemDroppedReasonCounts: Record<string, OsvDroppedReasonCounts> = {};
    const ecosystemDroppedSamples: Record<string, OsvDroppedAdvisorySample[]> = {};
    let maxModified: string | undefined;
    for (const archive of archives) {
      options.onProgress?.(`Ingesting verified OSV ${archive.ecosystem} archive`);
      const ingestSummary = await ingestArchive(client, archive, workDirectory);
      ecosystemRecordCounts[archive.ecosystem] = ingestSummary.recordCount;
      ecosystemDroppedCounts[archive.ecosystem] = ingestSummary.droppedCount;
      ecosystemDroppedReasonCounts[archive.ecosystem] = ingestSummary.droppedReasonCounts;
      ecosystemDroppedSamples[archive.ecosystem] = ingestSummary.droppedSamples;
      if (!maxModified || Date.parse(ingestSummary.maxModified) > Date.parse(maxModified)) {
        maxModified = ingestSummary.maxModified;
      }
    }

    assertDroppedAdvisoryRateWithinLimit(ecosystemRecordCounts, ecosystemDroppedCounts);
    assertSnapshotDateCoversMaxModified(options.snapshotDate, maxModified!);

    // Publish the exact verified archives before committing their SQL projection. If
    // publication fails, the transaction rolls back rather than pairing new rows with
    // a stale same-date scanner cache.
    const scannerDatabaseDirectory = await publishScannerDatabases(
      archives,
      options.scannerCacheDirectory,
      options.snapshotDate,
    );
    const sourceUrl = `${options.mirrorBaseUrl}/${OSV_BUCKET_PATH}`;
    const ingestedAt = await insertOsvSnapshot(
      client,
      options.snapshotDate,
      sourceUrl,
      ecosystemRecordCounts,
      ecosystemDroppedCounts,
      ecosystemDroppedReasonCounts,
      ecosystemDroppedSamples,
      maxModified!,
    );
    await client.query('COMMIT');
    transactionStarted = false;

    return {
      snapshotDate: options.snapshotDate,
      ingestedAt,
      maxModified: maxModified!,
      sourceUrl,
      ecosystemRecordCounts,
      ecosystemDroppedCounts,
      ecosystemDroppedReasonCounts,
      ecosystemDroppedSamples,
      downloadedBytes: archives.reduce((total, archive) => total + archive.size, 0),
      workDirectory,
      downloadsRetained: options.keepDownloads === true,
      scannerDatabaseDirectory,
    } satisfies OsvSyncSummary;
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    if (!options.keepDownloads) {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}
