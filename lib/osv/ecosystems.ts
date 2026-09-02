export const OSV_ECOSYSTEMS = [
  'npm',
  'PyPI',
  'Maven',
  'Go',
  'Packagist',
  'RubyGems',
  'NuGet',
  'crates.io',
  'Hex',
  'Pub',
] as const;

export type OsvEcosystem = typeof OSV_ECOSYSTEMS[number];
