import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const { buildSoftwareContext } = await import('./softwareContext.ts');

async function loadFixture(name) {
  const content = await readFile(new URL(`../../tests/fixtures/${name}`, import.meta.url), 'utf8');
  return { content, sbom: JSON.parse(content) };
}

function normalizeFixture(sbom) {
  if (sbom.spdxVersion || sbom.SPDXID) {
    const packages = (sbom.packages ?? []).map(pkg => ({
      name: pkg.name,
      version: pkg.versionInfo ?? pkg.version,
      ecosystem: 'npm',
      id: pkg.SPDXID,
    }));
    const dependencies = (sbom.relationships ?? [])
      .filter(relationship => [
        'DEPENDS_ON',
        'BUILD_DEPENDS_ON',
        'DEV_DEPENDS_ON',
        'RUNTIME_DEPENDS_ON',
      ].includes(relationship.relationshipType))
      .map(relationship => ({
        parent: relationship.spdxElementId,
        child: relationship.relatedSpdxElement,
        relationship: relationship.relationshipType,
      }));
    return {
      softwareName: sbom.name,
      packages,
      dependencies,
    };
  }

  const packages = (sbom.components ?? []).map(component => ({
    name: component.name,
    version: component.version,
    ecosystem: component.purl?.split(':')[1] ?? 'unknown',
    id: component['bom-ref'] ?? component.purl,
  }));
  const dependencies = (sbom.dependencies ?? []).flatMap(dependency => (
    (dependency.dependsOn ?? []).map(child => ({
      parent: dependency.ref,
      child,
      relationship: 'DEPENDS_ON',
    }))
  ));
  return {
    softwareName: sbom.metadata?.component?.name ?? 'unknown',
    packages,
    dependencies,
  };
}

function packageVersionSet(packages) {
  return new Set(packages.map(pkg => `${pkg.name}\u0000${pkg.version ?? 'unknown'}`));
}

function contextEdgeSet(context) {
  return new Set(context.packages_depends_on.flatMap(pkg => (
    pkg.dependencies.map(dependency => (
      `${pkg.package_name}\u0000${pkg.package_version}\u0000${dependency.package_name}\u0000${dependency.package_version}\u0000${dependency.relationship}`
    ))
  )));
}

function normalizedEdgeSet(normalized) {
  const packageMap = new Map(normalized.packages.map(pkg => [pkg.id ?? pkg.name, pkg]));
  return new Set(normalized.dependencies.map(dependency => {
    const parent = packageMap.get(dependency.parent);
    const child = packageMap.get(dependency.child);
    assert.ok(parent);
    assert.ok(child);
    return `${parent.name}\u0000${parent.version ?? 'unknown'}\u0000${child.name}\u0000${child.version ?? 'unknown'}\u0000${dependency.relationship}`;
  }));
}

const canonicalSmallFixtureEdges = new Set([
  'react\u000018.3.1\u0000lodash\u00004.17.20\u0000DEPENDS_ON',
  'react\u000018.3.1\u0000axios\u00000.21.1\u0000DEPENDS_ON',
  'axios\u00000.21.1\u0000minimist\u00001.2.5\u0000DEPENDS_ON',
  'commander\u000011.1.0\u0000kleur\u00004.1.5\u0000DEPENDS_ON',
  'nanoid\u00005.0.7\u0000is-number\u00007.0.0\u0000DEPENDS_ON',
  'zod\u00003.23.8\u0000fast-deep-equal\u00003.1.3\u0000DEPENDS_ON',
]);

async function buildFixtureContext(fixtureName, scannedPackageCount) {
  const { content, sbom } = await loadFixture(fixtureName);
  const normalized = normalizeFixture(sbom);
  return {
    normalized,
    context: buildSoftwareContext({
      ...normalized,
      sbomContent: content,
      vulnerabilityResults: [],
      scannedPackageCount: scannedPackageCount ?? normalized.packages.length,
    }),
  };
}

for (const fixtureName of ['small-spdx.json', 'small-cyclonedx.json']) {
  test(`${fixtureName} preserves every package, version, and normalized dependency edge`, async () => {
    const { normalized, context } = await buildFixtureContext(fixtureName);

    assert.deepEqual(
      packageVersionSet(context.packages_depends_on.map(pkg => ({
        name: pkg.package_name,
        version: pkg.package_version,
      }))),
      packageVersionSet(normalized.packages),
    );
    assert.equal(contextEdgeSet(context).size, 6);
    assert.deepEqual(contextEdgeSet(context), normalizedEdgeSet(normalized));
    assert.deepEqual(contextEdgeSet(context), canonicalSmallFixtureEdges);
    assert.equal(context.total_package_count, normalized.packages.length);
    assert.equal(context.scanned_package_count, normalized.packages.length);
    assert.equal(context.scan_truncated, false);
  });
}

test('SPDX and CycloneDX normalize to the same six-edge graph', async () => {
  const spdx = await buildFixtureContext('small-spdx.json');
  const cycloneDx = await buildFixtureContext('small-cyclonedx.json');

  assert.deepEqual(contextEdgeSet(spdx.context), contextEdgeSet(cycloneDx.context));
  assert.deepEqual(contextEdgeSet(spdx.context), canonicalSmallFixtureEdges);
  assert.deepEqual(
    spdx.context.packages_depends_on
      .filter(pkg => pkg.dependencies.some(dependency => dependency.package_name === 'lodash'))
      .map(pkg => pkg.package_name),
    ['react'],
  );
});

test('oversize SPDX context retains all packages and exposes the 200/150 scan truncation', async () => {
  const { normalized, context } = await buildFixtureContext('oversize-spdx.json', 150);

  assert.equal(normalized.packages.length, 200);
  assert.equal(context.packages_depends_on.length, 200);
  assert.deepEqual(
    packageVersionSet(context.packages_depends_on.map(pkg => ({
      name: pkg.package_name,
      version: pkg.package_version,
    }))),
    packageVersionSet(normalized.packages),
  );
  assert.equal(context.total_package_count, 200);
  assert.equal(context.scanned_package_count, 150);
  assert.equal(context.scan_truncated, true);
});

test('vulnerability minimization keeps grounding fields and drops prose metadata', async () => {
  const { content, sbom } = await loadFixture('small-spdx.json');
  const normalized = normalizeFixture(sbom);
  const vulnerablePackage = normalized.packages[0];
  const context = buildSoftwareContext({
    ...normalized,
    sbomContent: content,
    scannedPackageCount: normalized.packages.length,
    vulnerabilityResults: [{
      package: vulnerablePackage,
      vulnerabilities: [{
        id: 'GHSA-synthetic-context',
        summary: 'Synthetic summary retained for grounding.',
        details: 'Verbose vulnerability details must be removed.',
        severity: [{ type: 'CVSS_V3', score: '9.8' }],
        affected: [{
          package: { name: vulnerablePackage.name, ecosystem: vulnerablePackage.ecosystem },
          ranges: [{
            type: 'SEMVER',
            events: [{ introduced: '0' }, { fixed: '4.17.21' }],
          }],
        }],
        references: [{ type: 'ADVISORY', url: 'https://example.invalid/advisory' }],
        database_specific: { severity: 'HIGH', verbose: 'drop this metadata' },
        credits: [{ name: 'Synthetic researcher' }],
      }],
    }],
  });

  const minimized = context.packages_depends_on[0].vulnerabilities[0];
  assert.deepEqual(minimized, {
    id: 'GHSA-synthetic-context',
    severity: [{ type: 'CVSS_V3', score: '9.8' }],
    summary: 'Synthetic summary retained for grounding.',
    affected_version_ranges: [{
      type: 'SEMVER',
      events: [{ introduced: '0' }, { fixed: '4.17.21' }],
    }],
    fixed_versions: ['4.17.21'],
  });
  assert.equal(Object.hasOwn(minimized, 'details'), false);
  assert.equal(Object.hasOwn(minimized, 'references'), false);
  assert.equal(Object.hasOwn(minimized, 'database_specific'), false);
  assert.equal(Object.hasOwn(minimized, 'credits'), false);
});

test('sbom_hash is a deterministic SHA3-256 content digest', () => {
  const context = buildSoftwareContext({
    softwareName: 'synthetic-empty-sbom',
    sbomContent: '',
    packages: [],
    dependencies: [],
    vulnerabilityResults: [],
    scannedPackageCount: 0,
  });

  assert.equal(
    context.sbom_hash,
    'a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a',
  );
});
