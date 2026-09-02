import 'dotenv/config';

import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import pg from 'pg';

import { config } from '../../lib/config.ts';
import {
  getCurrentOsvSnapshot,
  matchOsvPackages,
  scanPackagesWithOsvScanner,
} from '../../lib/osv/match.ts';

const repositoryRoot = new URL('../..', import.meta.url);

// malformed.json is deliberately excluded: it is a parse-failure fixture and
// therefore produces no software context or package versions to cross-check.
const FIXTURES = [
  'small-spdx.json',
  'small-cyclonedx.json',
  'oversize-spdx.json',
];

const UNREACHABLE_DATABASE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPERM',
  'ETIMEDOUT',
]);

function isDatabaseUnreachable(error) {
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every(isDatabaseUnreachable);
  }
  return Boolean(
    error
    && typeof error === 'object'
    && UNREACHABLE_DATABASE_CODES.has(error.code),
  );
}

function spdxEcosystem(package_) {
  const location = String(package_.downloadLocation ?? '').toLowerCase();
  if (location.includes('pypi') || location.includes('python')) return 'PyPI';
  if (location.includes('maven')) return 'Maven';
  if (location.includes('nuget')) return 'NuGet';
  if (location.includes('golang') || location.includes('go.mod')) return 'Go';
  if (location.includes('rubygems')) return 'RubyGems';
  if (location.includes('cargo') || location.includes('crates')) return 'crates.io';
  return 'npm';
}

function cycloneDxEcosystem(purl) {
  const type = purl.slice(4).split('/')[0].toLowerCase();
  return ({
    npm: 'npm',
    pypi: 'PyPI',
    maven: 'Maven',
    golang: 'Go',
    composer: 'Packagist',
    gem: 'RubyGems',
    nuget: 'NuGet',
    cargo: 'crates.io',
    hex: 'Hex',
    pub: 'Pub',
  })[type] ?? type;
}

async function fixturePackages(fixtureName) {
  const fixture = JSON.parse(await readFile(
    new URL(`../fixtures/${fixtureName}`, import.meta.url),
    'utf8',
  ));

  if (Array.isArray(fixture.packages)) {
    return fixture.packages
      .filter(package_ => package_.name && (package_.versionInfo || package_.version))
      .map(package_ => ({
        name: package_.name,
        version: package_.versionInfo ?? package_.version,
        ecosystem: spdxEcosystem(package_),
      }));
  }

  if (Array.isArray(fixture.components)) {
    return fixture.components
      .filter(component => component.name && component.version && component.purl)
      .map(component => ({
        name: component.name,
        version: component.version,
        ecosystem: cycloneDxEcosystem(component.purl),
      }));
  }

  throw new Error(`${fixtureName} did not contain packages`);
}

function packageKey(package_) {
  return JSON.stringify([package_.ecosystem, package_.name, package_.version]);
}

async function crossCheckFixture(context, fixtureName) {
  if (!process.env.DATABASE_URL) {
    context.skip('DATABASE_URL is not configured; skipping OSV matcher cross-check');
    return;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    try {
      await client.connect();
    } catch (error) {
      if (isDatabaseUnreachable(error)) {
        context.skip('DATABASE_URL is configured but Postgres is unreachable; skipping OSV matcher cross-check');
        return;
      }
      throw error;
    }

    const packages = await fixturePackages(fixtureName);
    assert.ok(packages.length > 0, `${fixtureName} must produce packages to cross-check`);
    const snapshot = await getCurrentOsvSnapshot(client);
    const scannerDatabaseDirectory = path.join(
      config.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY,
      snapshot.snapshotDate,
    );
    const scannerMatches = await scanPackagesWithOsvScanner(
      packages,
      scannerDatabaseDirectory,
      config.OSV_SCANNER_PATH,
    );
    const localMatches = await matchOsvPackages(client, packages);

    const expected = packages.map(package_ => ({
      package: package_,
      vulnerabilityIds: [...(scannerMatches.get(packageKey(package_)) ?? [])].sort(),
    }));
    const actual = localMatches.map(match => ({
      package: match.package,
      vulnerabilityIds: match.vulnerabilities.map(vulnerability => vulnerability.id).sort(),
    }));

    assert.deepEqual(actual, expected);
  } finally {
    await client.end().catch(() => {});
  }
}

for (const fixtureName of FIXTURES) {
  test(`local OSV matcher agrees with osv-scanner --offline for ${fixtureName}`, async context => {
    await crossCheckFixture(context, fixtureName);
  });
}
