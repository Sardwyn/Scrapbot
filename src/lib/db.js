// /var/www/scrapbot/src/lib/db.js
import dotenv from 'dotenv';
import pg from 'pg';

import { fileURLToPath } from 'url';
import path from 'path';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

// Load env for BOTH main app & workers, regardless of CWD
dotenv.config({ path: path.join(repoRoot, '.env') });

const url = process.env.DATABASE_URL;

if (!url || typeof url !== 'string') {
  console.error('[db] Invalid or missing DATABASE_URL for Scrapbot');
  throw new Error('DATABASE_URL not set or not a string');
}

// Mask password in logs
const safeUrl = url.replace(/(postgres:\/\/[^:]+:)[^@]+@/, '$1***@');
console.log('[db] Connecting with DATABASE_URL:', safeUrl);

const pool = new Pool({
  connectionString: url,
});

// Simple query helper
export async function q(text, params) {
  return pool.query(text, params);
}

// 🔹 Named export for callers like `import { pool } from '../lib/db.js'`
export { pool };

// 🔹 Backwards-compatible alias
export const db = pool;

// 🔹 Default export for `import db from '../lib/db.js'`
export default pool;
