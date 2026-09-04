import assert from 'node:assert/strict';
import fs from 'node:fs';

const ledgerDir = new URL('./', import.meta.url);
const smallSpdxFixtureUrl = new URL('../fixtures/small-spdx.json', import.meta.url);

function readJson(name) {
  return JSON.parse(fs.readFileSync(new URL(name, ledgerDir), 'utf8'));
}

function hostMatches(pattern, host) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host;
}

function validateLedger(ledger, expected, smallSpdxPackageCount) {
  const failures = [];

  if (ledger.profile !== expected.profile) {
    failures.push(`Profile mismatch: expected ${expected.profile}, observed ${ledger.profile}`);
  }

  for (const destination of ledger.destinations || []) {
    const declaration = expected.allowed.find(item => hostMatches(item.host, destination.host));
    if (!declaration) {
      failures.push(`${ledger.profile}: unexpected observed host ${destination.host}`);
      continue;
    }
    if (destination.carriesInventory && !declaration.carriesInventory) {
      failures.push(`${ledger.profile}: ${destination.host} carried undeclared inventory`);
    }
  }

  for (const declaration of expected.allowed) {
    const observed = (ledger.destinations || []).some(item => (
      hostMatches(declaration.host, item.host)
    ));
    if (!observed) failures.push(`${ledger.profile}: expected host was not observed: ${declaration.host}`);
  }

  const inventoryHosts = (ledger.destinations || []).filter(item => item.carriesInventory);
  if (inventoryHosts.length > expected.maxInventoryCarryingHosts) {
    failures.push(
      `${ledger.profile}: observed ${inventoryHosts.length} inventory-carrying hosts; maximum is ${expected.maxInventoryCarryingHosts}`,
    );
  }

  if (ledger.instrumentation?.sinkCapturedExpectedHosts !== true) {
    failures.push(`${ledger.profile}: local sink did not capture every expected automated host`);
  }
  if (ledger.instrumentation?.interceptorCapturedExpectedHosts !== true) {
    failures.push(`${ledger.profile}: fetch interceptor did not capture every expected automated host`);
  }
  if ((ledger.instrumentation?.unexpectedTransportHosts || []).length > 0) {
    failures.push(
      `${ledger.profile}: unexpected transport hosts: ${ledger.instrumentation.unexpectedTransportHosts.join(', ')}`,
    );
  }

  const expectedSmallRequests = ledger.profile === 'hosted' ? smallSpdxPackageCount : 0;
  const expectedOversizeRequests = ledger.profile === 'hosted' ? 150 : 0;
  if (ledger.runs?.smallSpdx?.osvRequestCount !== expectedSmallRequests) {
    failures.push(
      `${ledger.profile}: expected ${expectedSmallRequests} small-fixture OSV requests, observed ${ledger.runs?.smallSpdx?.osvRequestCount}`,
    );
  }
  if (ledger.regressionGuards?.oversizeSpdxOsvQueries !== expectedOversizeRequests) {
    failures.push(
      `${ledger.profile}: expected ${expectedOversizeRequests} oversize OSV requests, observed ${ledger.regressionGuards?.oversizeSpdxOsvQueries}`,
    );
  }

  if (ledger.profile === 'offline') {
    const proof = ledger.executionProof;
    if ((ledger.destinations || []).some(item => item.host === 'api.osv.dev')) {
      failures.push('offline: api.osv.dev must be absent from observed destinations');
    }
    if (proof?.snapshot?.snapshotDate !== expected.snapshot.snapshotDate) {
      failures.push('offline: snapshot date does not match the declared pin');
    }
    if (proof?.snapshot?.maxModified !== expected.snapshot.maxModified) {
      failures.push('offline: max_modified declaration does not match the declared pin');
    }
    if (proof?.snapshot?.databaseMaxModified !== expected.snapshot.databaseMaxModified) {
      failures.push('offline: stored max_modified does not match the microsecond-normalized pin');
    }
    if (!(proof?.snapshot?.advisoryRows > 0) || !(proof?.snapshot?.vulnerabilityRows > 0)) {
      failures.push('offline: snapshot row-count proof is missing');
    }
    if (proof?.smallUpload?.packagesScanned !== smallSpdxPackageCount
      || !(proof?.smallUpload?.vulnerabilitiesFound > 0)) {
      failures.push('offline: upload did not prove a live local vulnerability scan');
    }
    if (!(proof?.packageQuery?.vulnerabilitiesFound > 0)) {
      failures.push('offline: package query did not prove a live local vulnerability lookup');
    }
    if (proof?.identifier?.resolvedViaAlias !== true
      || proof?.identifier?.requestedIdentifier === proof?.identifier?.resolvedAdvisoryId) {
      failures.push('offline: identifier lookup did not prove the disclosed alias substitution');
    }
  }

  return { failures, inventoryHosts };
}

const smallSpdxFixture = JSON.parse(fs.readFileSync(smallSpdxFixtureUrl, 'utf8'));
const smallSpdxPackageCount = smallSpdxFixture.packages?.length;
assert.ok(Number.isInteger(smallSpdxPackageCount), 'Small SPDX fixture must contain packages');

const profiles = [
  { ledger: readJson('ledger-current.json'), expected: readJson('expected.json') },
  { ledger: readJson('ledger-offline.json'), expected: readJson('expected-offline.json') },
];
const validations = profiles.map(({ ledger, expected }) => ({
  ledger,
  ...validateLedger(ledger, expected, smallSpdxPackageCount),
}));
const failures = validations.flatMap(validation => validation.failures);
assert.equal(failures.length, 0, failures.join('\n'));

for (const { ledger, inventoryHosts } of validations) {
  console.log(`Ledger check passed for profile: ${ledger.profile}`);
  for (const destination of ledger.destinations) {
    console.log(
      `- ${destination.host}: ${destination.requestCount} requests, ${destination.totalRequestBodySize} total body bytes, ${destination.maxRequestBodySize} largest body, ${destination.carriesInventory ? 'CARRIES_INVENTORY' : 'INVENTORY_INDEPENDENT'}`,
    );
  }
  console.log(`Inventory-carrying hosts: ${inventoryHosts.length}`);
  console.log(`Small SPDX intercepted OSV requests: ${ledger.runs.smallSpdx.osvRequestCount}`);
  console.log(`Oversize SPDX intercepted OSV requests: ${ledger.regressionGuards.oversizeSpdxOsvQueries}`);
}
console.log('Manual deployment row retained: Vercel edge/runtime');
