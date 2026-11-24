// D1 tiruan di atas node:sqlite untuk tes Worker.
//
// Bentuk API-nya meniru D1: prepare().bind().first/all/run, dan batch dalam satu transaksi.
// Setiap query dihitung, karena Worker paket gratis dibatasi 50 query D1 per pemanggilan —
// tes yang tidak menghitungnya tidak akan tahu kapan sebuah RPC melewati batas itu.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

export const createD1 = (files) => {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of files) sqlite.exec(fs.readFileSync(file, 'utf8'));
  const stats = { queries: 0 };

  const makeStatement = (sql, params = []) => ({
    sql,
    params,
    bind(...bound) { return makeStatement(sql, bound); },
    first: async () => { stats.queries += 1; return sqlite.prepare(sql).get(...params) ?? null; },
    all: async () => { stats.queries += 1; return { results: sqlite.prepare(sql).all(...params) }; },
    run: async () => {
      stats.queries += 1;
      const info = sqlite.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
  });

  const db = {
    prepare: (sql) => makeStatement(sql),
    batch: async (statements) => {
      stats.queries += statements.length;
      sqlite.exec('begin');
      try {
        // Seperti D1, batch juga boleh berisi SELECT; hasilnya ada di results.
        const results = statements.map((s) => {
          if (/^\s*(select|with)\b/i.test(s.sql)) {
            return { success: true, results: sqlite.prepare(s.sql).all(...s.params), meta: { changes: 0 } };
          }
          const info = sqlite.prepare(s.sql).run(...s.params);
          return { success: true, results: [], meta: { changes: Number(info.changes) } };
        });
        sqlite.exec('commit');
        return results;
      } catch (error) {
        sqlite.exec('rollback');
        throw error;
      }
    },
  };
  return { db, sqlite, stats };
};
