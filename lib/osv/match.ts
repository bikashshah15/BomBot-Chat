import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { config } from '../config.ts';
import {
  getOsvAdvisoriesByIds,
  getOsvAdvisoryByIdentifier,
  getOsvVulnerabilityRowsByIdentifier,
  type OsvQueryClient,
  type OsvVulnerabilityRow,
} from './db.ts';
import type { OsvEcosystem } from './ecosystems.ts';
import {
  OSVMatcherSnapshotDisagreementError,
  OSVPackageVersionRequiredError,
  OSVScannerExecutionError,
  OSVScannerOutputError,
} from './errors.ts';

export interface OsvPackageInput {
  name: string;
  version: string;
  ecosystem: OsvEcosystem;
}

export interface OsvMatchedVulnerability {
  id: string;
  severity?: unknown;
  database_specific?: unknown;
  aliases?: unknown;
  summary?: string | null;
  modified: string;
  affected: Array<{
    package?: { ecosystem?: unknown; name?: unknown };
    ranges?: unknown[];
    versions?: unknown[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface OsvPackageMatch {
  package: OsvPackageInput;
  vulnerabilities: OsvMatchedVulnerability[];
}

export interface OsvScannerOptions {
  scannerPath?: string;
  scannerCacheDirectory?: string;
}

interface ScannerVulnerability {
  id?: unknown;
}

interface ScannerPackageResult {
  package?: {
    name?: unknown;
    version?: unknown;
    ecosystem?: unknown;
  };
  vulnerabilities?: ScannerVulnerability[];
}

interface ScannerOutput {
  results?: Array<{ packages?: ScannerPackageResult[] }>;
}

interface CurrentSnapshot {
  snapshotDate: string;
}

function packageKey(package_: OsvPackageInput) {
  return JSON.stringify([package_.ecosystem, package_.name, package_.version]);
}

export function reconstructOsvVulnerability(
  row: OsvVulnerabilityRow,
): OsvMatchedVulnerability {
  return reconstructOsvVulnerabilityRows([row]);
}

export function reconstructOsvVulnerabilityRows(
  rows: OsvVulnerabilityRow[],
): OsvMatchedVulnerability {
  const [firstRow] = rows;
  return {
    id: firstRow.id,
    severity: firstRow.severity,
    database_specific: firstRow.databaseSpecific,
    aliases: firstRow.aliases,
    summary: firstRow.summary,
    modified: firstRow.modified,
    affected: rows.map(row => {
      const storedRanges = row.ranges as { ranges?: unknown; versions?: unknown };
      return {
        package: { ecosystem: row.ecosystem, name: row.packageName },
        ranges: Array.isArray(storedRanges?.ranges) ? storedRanges.ranges : [],
        versions: Array.isArray(storedRanges?.versions) ? storedRanges.versions : [],
      };
    }),
  };
}

export async function getOsvVulnerabilityByIdentifier(
  client: OsvQueryClient,
  identifier: string,
) {
  return getOsvAdvisoryByIdentifier(client, identifier) as Promise<OsvMatchedVulnerability | null>;
}

function rowMatchesPackage(row: OsvVulnerabilityRow, package_: OsvPackageInput) {
  return row.packageName === package_.name
    && (
      row.ecosystem === package_.ecosystem
      || row.ecosystem.startsWith(`${package_.ecosystem}:`)
    );
}

function parseScannerMatches(output: string) {
  let parsed: ScannerOutput;
  try {
    parsed = JSON.parse(output) as ScannerOutput;
  } catch {
    throw new OSVScannerOutputError();
  }

  if (!Array.isArray(parsed.results)) throw new OSVScannerOutputError();

  const matches = new Map<string, Set<string>>();
  for (const result of parsed.results) {
    if (!Array.isArray(result.packages)) continue;
    for (const packageResult of result.packages) {
      const scannerPackage = packageResult.package;
      if (
        typeof scannerPackage?.name !== 'string'
        || typeof scannerPackage.version !== 'string'
        || typeof scannerPackage.ecosystem !== 'string'
      ) {
        throw new OSVScannerOutputError();
      }

      const key = JSON.stringify([
        scannerPackage.ecosystem,
        scannerPackage.name,
        scannerPackage.version,
      ]);
      const ids = matches.get(key) ?? new Set<string>();
      for (const vulnerability of packageResult.vulnerabilities ?? []) {
        if (typeof vulnerability.id !== 'string') throw new OSVScannerOutputError();
        ids.add(vulnerability.id);
      }
      matches.set(key, ids);
    }
  }
  return matches;
}

async function executeScanner(
  scannerPath: string,
  scannerCacheDirectory: string,
  lockfilePath: string,
) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      scannerPath,
      [
        'scan',
        'source',
        '--lockfile',
        `osv-scanner:${lockfilePath}`,
        '--offline',
        '--format',
        'json',
        '--all-vulns',
        '--verbosity',
        'error',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: {
          NODE_ENV: process.env.NODE_ENV ?? 'production',
          PATH: process.env.PATH,
          OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: scannerCacheDirectory,
        },
      },
      (error, stdout) => {
        if (error) {
          const rawExitCode = (error as { code?: unknown }).code;
          const exitCode = typeof rawExitCode === 'number' || typeof rawExitCode === 'string'
            ? rawExitCode
            : null;
          if (exitCode !== 1) {
            reject(new OSVScannerExecutionError(exitCode));
            return;
          }
        }
        resolve(stdout);
      },
    );
  });
}

export async function scanPackagesWithOsvScanner(
  packages: OsvPackageInput[],
  scannerCacheDirectory: string,
  scannerPath = config.OSV_SCANNER_PATH,
) {
  for (const package_ of packages) {
    if (!package_.version) throw new OSVPackageVersionRequiredError();
  }
  if (packages.length === 0) return new Map<string, Set<string>>();

  const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'bombot-osv-match-'));
  const lockfilePath = path.join(workDirectory, 'osv-scanner.json');
  try {
    await writeFile(lockfilePath, JSON.stringify({
      results: [{
        packages: packages.map(package_ => ({ package: package_ })),
      }],
    }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const output = await executeScanner(scannerPath, scannerCacheDirectory, lockfilePath);
    return parseScannerMatches(output);
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function getCurrentOsvSnapshot(client: OsvQueryClient) {
  const result = await client.query(
    `SELECT snapshot_date::text AS snapshot_date
     FROM osv_snapshots
     ORDER BY ingested_at DESC
     LIMIT 1`,
  ) as { rows: Array<{ snapshot_date: string }> };
  if (result.rows.length !== 1) {
    throw new OSVScannerExecutionError('missing-snapshot');
  }
  return { snapshotDate: result.rows[0].snapshot_date } satisfies CurrentSnapshot;
}

export async function matchOsvPackages(
  client: OsvQueryClient,
  packages: OsvPackageInput[],
  options: OsvScannerOptions = {},
) {
  if (packages.length === 0) return [];
  const snapshot = await getCurrentOsvSnapshot(client);
  const scannerDatabaseDirectory = path.join(
    options.scannerCacheDirectory ?? config.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY,
    snapshot.snapshotDate,
  );
  const scannerMatches = await scanPackagesWithOsvScanner(
    packages,
    scannerDatabaseDirectory,
    options.scannerPath,
  );
  const matchedIds = [...new Set([...scannerMatches.values()].flatMap(ids => [...ids]))].sort();

  const advisories = await getOsvAdvisoriesByIds(client, matchedIds);
  const advisoriesById = new Map(
    advisories.map(advisory => [advisory.id, advisory.record as OsvMatchedVulnerability]),
  );
  const missingIds = matchedIds.filter(id => !advisoriesById.has(id));
  if (missingIds.length > 0) throw new OSVMatcherSnapshotDisagreementError(missingIds);

  return packages.map(package_ => ({
    package: package_,
    vulnerabilities: [...(scannerMatches.get(packageKey(package_)) ?? [])]
      .sort()
      .map(id => advisoriesById.get(id)!),
  })) satisfies OsvPackageMatch[];
}
