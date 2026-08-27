import fs from 'node:fs/promises';

import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be configured before running db:migrate');
}

const schemaUrl = new URL('../db/schema.sql', import.meta.url);
const schema = await fs.readFile(schemaUrl, 'utf8');
const client = new Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query(schema);
  console.log('Database schema migration completed.');
} finally {
  await client.end();
}
