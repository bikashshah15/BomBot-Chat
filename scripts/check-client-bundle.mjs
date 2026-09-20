import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const roots = ['dist/assets', 'public/dist'];
const forbidden = ['LLM_API_KEY', 'ALT_LLM_API_KEY', 'DEMO_ACCESS_TOKEN', 'sk-'];
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (file.endsWith('.js')) files.push(file);
  }
}

for (const root of roots) await collect(root);
const matches = [];
for (const file of files) {
  const contents = await readFile(file, 'utf8');
  for (const token of forbidden) {
    if (contents.includes(token)) matches.push(`${file}: ${token}`);
  }
}
if (matches.length > 0) {
  console.error(matches.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Client bundle check passed: ${files.length} JavaScript files; 0 forbidden-token matches.`);
}
