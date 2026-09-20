import { createHash } from 'node:crypto';

export interface NormalizedSoftwarePackage {
  name: string;
  version?: string;
  ecosystem: string;
  id?: string;
}

export interface NormalizedDependencyRelationship {
  parent: string;
  child: string;
  relationship: string;
}

export interface OsvSeverity {
  type: string;
  score: string;
}

export interface OsvRangeEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

export interface OsvVulnerability {
  id: string;
  summary?: string;
  details?: string;
  severity?: OsvSeverity[];
  affected?: Array<{
    package?: {
      name?: string;
      ecosystem?: string;
    };
    ranges?: Array<{
      type: string;
      events?: OsvRangeEvent[];
    }>;
  }>;
  references?: unknown;
  database_specific?: {
    severity?: string;
    [key: string]: unknown;
  };
  credits?: unknown;
}

export interface NormalizedVulnerabilityResult {
  package: NormalizedSoftwarePackage;
  vulnerabilities: OsvVulnerability[];
}

export interface SoftwareContextVersionRange {
  type: string;
  events: OsvRangeEvent[];
}

export interface SoftwareContextVulnerability {
  id: string;
  severity: OsvSeverity[];
  summary: string;
  affected_version_ranges: SoftwareContextVersionRange[];
  fixed_versions: string[];
}

export interface SoftwareContextDependency {
  package_name: string;
  package_version: string;
  relationship: string;
}

export interface SoftwarePackageContext {
  package_name: string;
  package_version: string;
  vulnerabilities: SoftwareContextVulnerability[];
  dependencies: SoftwareContextDependency[];
}

export interface SoftwareContext {
  software_name: string;
  sbom_hash: string;
  total_package_count: number;
  scanned_package_count: number;
  scan_truncated: boolean;
  packages_depends_on: SoftwarePackageContext[];
}

export interface BuildSoftwareContextInput {
  softwareName: string;
  sbomContent: string;
  packages: NormalizedSoftwarePackage[];
  dependencies: NormalizedDependencyRelationship[];
  vulnerabilityResults: NormalizedVulnerabilityResult[];
  scannedPackageCount: number;
}

function packageIdentity(pkg: NormalizedSoftwarePackage): string {
  return [pkg.id ?? '', pkg.name, pkg.version ?? '', pkg.ecosystem].join('\u0000');
}

export function minimizeVulnerability(vulnerability: OsvVulnerability): SoftwareContextVulnerability {
  const affectedVersionRanges = (vulnerability.affected ?? []).flatMap(affected => (
    affected.ranges ?? []
  )).map(range => ({
    type: range.type,
    events: (range.events ?? []).map(event => ({
      ...(event.introduced !== undefined ? { introduced: event.introduced } : {}),
      ...(event.fixed !== undefined ? { fixed: event.fixed } : {}),
      ...(event.last_affected !== undefined ? { last_affected: event.last_affected } : {}),
      ...(event.limit !== undefined ? { limit: event.limit } : {}),
    })),
  }));
  const fixedVersions = [...new Set(
    affectedVersionRanges.flatMap(range => (
      range.events.flatMap(event => event.fixed === undefined ? [] : [event.fixed])
    )),
  )];
  const severity = (vulnerability.severity ?? []).map(item => ({
    type: item.type,
    score: item.score,
  }));
  if (severity.length === 0 && vulnerability.database_specific?.severity) {
    severity.push({
      type: 'DATABASE_SPECIFIC',
      score: vulnerability.database_specific.severity,
    });
  }

  return {
    id: vulnerability.id,
    severity,
    summary: vulnerability.summary ?? '',
    affected_version_ranges: affectedVersionRanges,
    fixed_versions: fixedVersions,
  };
}

export function buildSoftwareContext(input: BuildSoftwareContextInput): SoftwareContext {
  if (!Number.isSafeInteger(input.scannedPackageCount)
    || input.scannedPackageCount < 0
    || input.scannedPackageCount > input.packages.length) {
    throw new Error('scannedPackageCount must be an integer between zero and the total package count');
  }

  const packageByReference = new Map<string, NormalizedSoftwarePackage>();
  for (const pkg of input.packages) {
    packageByReference.set(pkg.id ?? pkg.name, pkg);
  }

  const dependenciesByParent = new Map<string, SoftwareContextDependency[]>();
  for (const dependency of input.dependencies) {
    const parent = packageByReference.get(dependency.parent);
    const child = packageByReference.get(dependency.child);
    if (!parent || !child) continue;

    const parentKey = packageIdentity(parent);
    const parentDependencies = dependenciesByParent.get(parentKey) ?? [];
    parentDependencies.push({
      package_name: child.name,
      package_version: child.version ?? 'unknown',
      relationship: dependency.relationship,
    });
    dependenciesByParent.set(parentKey, parentDependencies);
  }

  const vulnerabilitiesByPackage = new Map<string, SoftwareContextVulnerability[]>();
  for (const result of input.vulnerabilityResults) {
    vulnerabilitiesByPackage.set(
      packageIdentity(result.package),
      result.vulnerabilities.map(minimizeVulnerability),
    );
  }

  return {
    software_name: input.softwareName,
    // This content hash is a cache/deduplication key, not a confidentiality boundary.
    sbom_hash: createHash('sha3-256').update(input.sbomContent, 'utf8').digest('hex'),
    total_package_count: input.packages.length,
    scanned_package_count: input.scannedPackageCount,
    scan_truncated: input.scannedPackageCount !== input.packages.length,
    packages_depends_on: input.packages.map(pkg => ({
      package_name: pkg.name,
      package_version: pkg.version ?? 'unknown',
      vulnerabilities: vulnerabilitiesByPackage.get(packageIdentity(pkg)) ?? [],
      dependencies: dependenciesByParent.get(packageIdentity(pkg)) ?? [],
    })),
  };
}
