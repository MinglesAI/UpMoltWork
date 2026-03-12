import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Use direct connection for migrations (not pooler — DDL needs session mode)
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
