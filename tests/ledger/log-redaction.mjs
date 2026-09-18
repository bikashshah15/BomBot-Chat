import assert from 'node:assert/strict';

export function fixturePackageNames(fixtures) {
  return [...new Set(fixtures.flatMap(fixture => [
    ...(fixture.packages ?? []), ...(fixture.components ?? []),
  ].map(pkg => pkg.name).filter(name => typeof name === 'string' && name.length > 0)))];
}

export function assertNoPackageLogs(logs, names) {
  for (const name of names) {
    assert.equal(logs.includes(name), false, 'Log redaction gate: fixture package name appeared in application output');
  }
}
