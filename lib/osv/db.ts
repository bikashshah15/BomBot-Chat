export interface OsvVulnerabilityRow {
  id: string;
  ecosystem: string;
  packageName: string;
  ranges: unknown;
  severity: unknown | null;
  databaseSpecific: unknown | null;
  aliases: unknown | null;
  summary: string | null;
  modified: string;
}

export interface OsvAdvisoryRow {
  id: string;
  aliases: unknown | null;
  record: unknown;
}

export interface OsvQueryClient {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const INSERT_BATCH_SIZE = 500;

export async function clearOsvSnapshot(client: OsvQueryClient) {
  await client.query('DELETE FROM osv_vulns');
  await client.query('DELETE FROM osv_advisories');
  await client.query('DELETE FROM osv_snapshots');
}

export async function insertOsvAdvisoryRows(
  client: OsvQueryClient,
  rows: OsvAdvisoryRow[],
) {
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders = batch.map((row, index) => {
      const position = index * 3;
      values.push(
        row.id,
        row.aliases === null ? null : JSON.stringify(row.aliases),
        JSON.stringify(row.record),
      );
      return `($${position + 1}, $${position + 2}::jsonb, $${position + 3}::jsonb)`;
    });

    const result = await client.query(
      `INSERT INTO osv_advisories (id, aliases, record)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (id) DO UPDATE SET
         aliases = EXCLUDED.aliases,
         record = EXCLUDED.record
       WHERE osv_advisories.record = EXCLUDED.record
       RETURNING id`,
      values,
    ) as { rowCount: number };
    if (result.rowCount !== batch.length) {
      throw new Error('OSV archives supplied conflicting raw records for the same advisory id');
    }
  }
}

export async function insertOsvVulnerabilityRows(
  client: OsvQueryClient,
  rows: OsvVulnerabilityRow[],
) {
  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders = batch.map((row, index) => {
      const position = index * 9;
      values.push(
        row.id,
        row.ecosystem,
        row.packageName,
        JSON.stringify(row.ranges),
        row.severity === null ? null : JSON.stringify(row.severity),
        row.databaseSpecific === null ? null : JSON.stringify(row.databaseSpecific),
        row.aliases === null ? null : JSON.stringify(row.aliases),
        row.summary,
        row.modified,
      );
      return `($${position + 1}, $${position + 2}, $${position + 3}, $${position + 4}::jsonb, $${position + 5}::jsonb, $${position + 6}::jsonb, $${position + 7}::jsonb, $${position + 8}, $${position + 9}::timestamptz)`;
    });

    await client.query(
      `INSERT INTO osv_vulns (
         id, ecosystem, package, ranges, severity, database_specific, aliases, summary, modified
       )
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (id, ecosystem, package) DO UPDATE SET
         ranges = EXCLUDED.ranges,
         severity = EXCLUDED.severity,
         database_specific = EXCLUDED.database_specific,
         aliases = EXCLUDED.aliases,
         summary = EXCLUDED.summary,
         modified = EXCLUDED.modified`,
      values,
    );
  }
}

export async function getOsvVulnerabilityRowsByIdentifier(
  client: OsvQueryClient,
  identifier: string,
) {
  const resolved = await client.query(
    `SELECT id
     FROM osv_vulns
     WHERE id = $1 OR aliases ? $1
     ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END, id
     LIMIT 1`,
    [identifier],
  ) as { rows: Array<{ id: string }> };
  if (resolved.rows.length === 0) return null;

  const result = await client.query(
    `SELECT
       id,
       ecosystem,
       package AS "packageName",
       ranges,
       severity,
       database_specific AS "databaseSpecific",
       aliases,
       summary,
       modified::text AS modified
     FROM osv_vulns
     WHERE id = $1
     ORDER BY ecosystem, package`,
    [resolved.rows[0].id],
  ) as { rows: OsvVulnerabilityRow[] };

  return result.rows;
}

export async function getOsvAdvisoryByIdentifier(
  client: OsvQueryClient,
  identifier: string,
) {
  const resolved = await client.query(
    `SELECT id
     FROM osv_advisories
     WHERE id = $1 OR aliases ? $1
     ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END, id
     LIMIT 1`,
    [identifier],
  ) as { rows: Array<{ id: string }> };
  if (resolved.rows.length === 0) return null;

  const result = await client.query(
    'SELECT record FROM osv_advisories WHERE id = $1',
    [resolved.rows[0].id],
  ) as { rows: Array<{ record: unknown }> };
  return result.rows[0]?.record ?? null;
}

export async function getOsvAdvisoriesByIds(
  client: OsvQueryClient,
  identifiers: string[],
) {
  if (identifiers.length === 0) return [];
  const result = await client.query(
    `SELECT id, record
     FROM osv_advisories
     WHERE id = ANY($1::text[])
     ORDER BY id`,
    [identifiers],
  ) as { rows: Array<{ id: string; record: unknown }> };
  return result.rows;
}

export async function insertOsvSnapshot(
  client: OsvQueryClient,
  snapshotDate: string,
  sourceUrl: string,
  ecosystemRecordCounts: Record<string, number>,
  ecosystemDroppedCounts: Record<string, number>,
  ecosystemDroppedReasonCounts: Record<string, unknown>,
  ecosystemDroppedSamples: Record<string, unknown[]>,
  maxModified: string,
) {
  const result = await client.query(
    `INSERT INTO osv_snapshots (
       snapshot_date,
       source_url,
       ecosystem_record_counts,
       ecosystem_dropped_counts,
       ecosystem_dropped_reason_counts,
       ecosystem_dropped_samples,
       max_modified
     ) VALUES ($1::date, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::timestamptz)
     RETURNING ingested_at`,
    [
      snapshotDate,
      sourceUrl,
      JSON.stringify(ecosystemRecordCounts),
      JSON.stringify(ecosystemDroppedCounts),
      JSON.stringify(ecosystemDroppedReasonCounts),
      JSON.stringify(ecosystemDroppedSamples),
      maxModified,
    ],
  ) as { rows: Array<{ ingested_at: Date | string }> };

  return new Date(result.rows[0].ingested_at).toISOString();
}
