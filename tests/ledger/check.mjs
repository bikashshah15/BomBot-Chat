import assert from 'node:assert/strict';
import fs from 'node:fs';

const expectedUrl = new URL('./expected.json', import.meta.url);
const ledgerUrl = new URL('./ledger-current.json', import.meta.url);

function hostMatches(pattern, host) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host;
}

const expected = JSON.parse(fs.readFileSync(expectedUrl, 'utf8'));
const ledger = JSON.parse(fs.readFileSync(ledgerUrl, 'utf8'));
const failures = [];

if (ledger.profile !== expected.profile) {
  failures.push(`Profile mismatch: expected ${expected.profile}, observed ${ledger.profile}`);
}

for (const destination of ledger.destinations || []) {
  const declaration = expected.allowed.find(item => hostMatches(item.host, destination.host));
  if (!declaration) {
    failures.push(`Unexpected observed host: ${destination.host}`);
    continue;
  }
  if (destination.carriesInventory && !declaration.carriesInventory) {
    failures.push(`${destination.host} carried inventory but is declared inventory-independent`);
  }
}

for (const declaration of expected.allowed) {
  const observed = (ledger.destinations || []).some(item => hostMatches(declaration.host, item.host));
  if (!observed) failures.push(`Expected host was not observed: ${declaration.host}`);
}

const inventoryHosts = (ledger.destinations || []).filter(item => item.carriesInventory);
if (inventoryHosts.length > expected.maxInventoryCarryingHosts) {
  failures.push(
    `Observed ${inventoryHosts.length} inventory-carrying hosts; maximum is ${expected.maxInventoryCarryingHosts}`,
  );
}

if (ledger.instrumentation?.sinkCapturedExpectedHosts !== true) {
  failures.push('The local sink did not capture every expected automated host');
}
if (ledger.instrumentation?.interceptorCapturedExpectedHosts !== true) {
  failures.push('The global fetch interceptor did not capture every expected automated host');
}
if ((ledger.instrumentation?.unexpectedTransportHosts || []).length > 0) {
  failures.push(
    `Unexpected transport hosts: ${ledger.instrumentation.unexpectedTransportHosts.join(', ')}`,
  );
}

if (ledger.regressionGuards?.oversizeSpdxOsvQueries !== 150) {
  failures.push(
    `Oversize SPDX regression guard expected 150 OSV queries, observed ${ledger.regressionGuards?.oversizeSpdxOsvQueries}`,
  );
}

assert.equal(failures.length, 0, failures.join('\n'));

console.log(`Ledger check passed for profile: ${ledger.profile}`);
for (const destination of ledger.destinations) {
  console.log(
    `- ${destination.host}: ${destination.requestCount} requests, ${destination.carriesInventory ? 'CARRIES_INVENTORY' : 'INVENTORY_INDEPENDENT'}`,
  );
}
console.log(`Inventory-carrying hosts: ${inventoryHosts.length}/${expected.maxInventoryCarryingHosts}`);
console.log(`Oversize SPDX regression guard: ${ledger.regressionGuards.oversizeSpdxOsvQueries} OSV queries`);
console.log('Manual deployment rows: Vercel edge/runtime and Vercel Analytics');
