import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { SQL } from "bun";

export async function runMigrations(
  sql: SQL,
  migrationsDirectory = resolve(process.cwd(), "migrations"),
): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
    .sort();

  for (const file of files) {
    const applied = await sql<{ version: string }[]>`
      SELECT version
      FROM schema_migrations
      WHERE version = ${file}
    `;

    if (applied.length > 0) {
      continue;
    }

    await sql.begin(async (transaction) => {
      await transaction.file(resolve(migrationsDirectory, file));
      await transaction`
        INSERT INTO schema_migrations (version)
        VALUES (${file})
      `;
    });
  }
}

if (import.meta.main) {
  const databaseUrl = Bun.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === "") {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const sql = new SQL(databaseUrl);
  try {
    await runMigrations(sql);
  } finally {
    await sql.close();
  }
}
