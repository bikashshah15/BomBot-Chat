## Current self-hosted PostgreSQL schema migration

Fresh Docker volumes receive `db/schema.sql` through the Postgres initialization mount.
Postgres does not rerun that initialization for an existing volume. To apply additive
schema changes without deleting existing `chat_logs` rows, configure `DATABASE_URL` and run:

```bash
npm run db:migrate
```

The command loads the local environment, applies the re-runnable schema to the current
database, and preserves existing rows. Do not use `docker compose down -v` as a migration
method because it deletes the database volume.
