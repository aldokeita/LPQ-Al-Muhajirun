// Data pendukung asisten AI yang di versi asalnya dibaca frontend langsung dari tabel dengan RLS:
// saran terakhir, riwayat chat, rapor terakhir, umpan balik, pustaka materi, dan evaluasi.
//
// Tabel-tabel ini sengaja tidak terdaftar di /api/data, jadi aturan RLS asalnya diterjemahkan di
// sini satu per satu.

import { RpcError } from '../../rpc/santri.js';
import { assistantScope, classFilterParam, parseJson, UUID } from '../access.js';
import { requireAdmin } from '../settings.js';
import { requireSantriInScope } from '../santri-data.js';
import { monthUsage } from './actions.js';

const nowIso = () => new Date().toISOString();
const ids = (list, max = 200) => (Array.isArray(list) ? [...new Set(list.map(String).filter((id) => UUID.test(id)))] : [])
  .slice(0, max);

// Saran terakhir per santri. Admin semua; guru hanya santri di kelasnya dan bila tidak senyap.
export const getLatestAiRecommendations = async (db, ctx, { santriIds }) => {
  const scope = await assistantScope(ctx);
  const list = ids(santriIds);
  if (!list.length || scope.blind) return {};
  const classes = classFilterParam(scope);
  const { results } = await db.prepare(`
    select "id", "santri_id", "hasil", "provider", "model", "created_at" from (
      select r.*, row_number() over (partition by r."santri_id" order by r."created_at" desc) as rn
        from "assistant_ai_recommendations" r
       where r."santri_id" in (select "value" from json_each(?))
         and (? is null or exists (select 1 from "class_memberships" cm
               where cm."santri_id" = r."santri_id" and cm."status" = 'active'
                 and cm."class_id" in (select "value" from json_each(?))))
    ) where rn = 1`).bind(JSON.stringify(list), classes, classes).all();
  return Object.fromEntries((results || []).map((r) => [r.santri_id, { ...r, hasil: parseJson(r.hasil, {}) }]));
};

export const getLatestAiReport = async (db, ctx, { santriId }) => {
  const scope = await assistantScope(ctx);
  await requireSantriInScope(db, scope, santriId);
  if (scope.blind) return null;
  const row = await db.prepare(`
    select "id", "bulan", "hasil", "provider", "model", "created_at" from "assistant_ai_reports"
     where "santri_id" = ? order by "created_at" desc limit 1`).bind(santriId).first();
  return row ? { ...row, hasil: parseJson(row.hasil, {}) } : null;
};

// ===== Riwayat chat: hanya milik sendiri =====

const requireOwnConversation = async (db, ctx, conversationId) => {
  if (!ctx.userId) throw new RpcError('AUTH_REQUIRED', 401);
  if (!UUID.test(String(conversationId || ''))) throw new RpcError('NOT_FOUND', 404);
  const row = await db.prepare('select "user_id" from "assistant_ai_conversations" where "id" = ?').bind(conversationId).first();
  if (!row || row.user_id !== ctx.userId) throw new RpcError('NOT_FOUND', 404);
};

export const listAiConversations = async (db, ctx) => {
  if (!ctx.userId) throw new RpcError('AUTH_REQUIRED', 401);
  const { results } = await db.prepare(`
    select "id", "judul", "class_id", "santri_id", "sumber", "updated_at" from "assistant_ai_conversations"
     where "user_id" = ? order by "updated_at" desc limit 20`).bind(ctx.userId).all();
  return results || [];
};

export const getAiMessages = async (db, ctx, { conversationId }) => {
  await requireOwnConversation(db, ctx, conversationId);
  const { results } = await db.prepare(`
    select "id", "role", "content", "created_at" from "assistant_ai_messages"
     where "conversation_id" = ? order by "created_at" asc`).bind(conversationId).all();
  return results || [];
};

export const deleteAiConversation = async (db, ctx, { conversationId }) => {
  await requireOwnConversation(db, ctx, conversationId);
  // Pesan dihapus eksplisit, tidak bergantung pada ON DELETE CASCADE.
  await db.batch([
    db.prepare('delete from "assistant_ai_messages" where "conversation_id" = ?').bind(conversationId),
    db.prepare('delete from "assistant_ai_conversations" where "id" = ? and "user_id" = ?').bind(conversationId, ctx.userId),
  ]);
  return { ok: true };
};

// ===== Umpan balik 👍/👎 =====

const FEEDBACK_KINDS = ['rekomendasi', 'kelas', 'chat', 'rapor'];

export const getMyAiFeedback = async (db, ctx, { jenis, targetIds }) => {
  if (!ctx.userId) throw new RpcError('AUTH_REQUIRED', 401);
  const list = ids(targetIds, 500);
  if (!FEEDBACK_KINDS.includes(jenis) || !list.length) return {};
  const { results } = await db.prepare(`
    select "target_id", "nilai", "komentar" from "assistant_ai_feedback"
     where "user_id" = ? and "jenis" = ? and "target_id" in (select "value" from json_each(?))`)
    .bind(ctx.userId, jenis, JSON.stringify(list)).all();
  return Object.fromEntries((results || []).map((row) => [row.target_id, row]));
};

export const saveAiFeedback = async (db, ctx, { jenis, targetId, nilai, komentar }) => {
  const scope = await assistantScope(ctx);
  if (!FEEDBACK_KINDS.includes(jenis) || !UUID.test(String(targetId || ''))) throw new RpcError('INVALID_REQUEST', 400);
  if (!nilai) {
    await db.prepare('delete from "assistant_ai_feedback" where "user_id" = ? and "jenis" = ? and "target_id" = ?')
      .bind(ctx.userId, jenis, targetId).run();
    return null;
  }
  if (!scope.admin && scope.role !== 'guru') throw new RpcError('CLASS_ACCESS_DENIED', 403);
  const value = Number(nilai) > 0 ? 1 : -1;
  const note = komentar ? String(komentar).trim().slice(0, 500) || null : null;
  const now = nowIso();
  await db.prepare(`
    insert into "assistant_ai_feedback" ("id", "user_id", "jenis", "target_id", "nilai", "komentar", "created_at", "updated_at")
    values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict ("user_id", "jenis", "target_id")
    do update set "nilai" = excluded."nilai", "komentar" = excluded."komentar", "updated_at" = excluded."updated_at"`)
    .bind(crypto.randomUUID(), ctx.userId, jenis, targetId, value, note, now, now).run();
  return { target_id: targetId, nilai: value, komentar: note };
};

// ===== Pustaka materi =====

export const listAiKnowledge = async (db, ctx) => {
  const scope = await assistantScope(ctx);
  if (!scope.admin && scope.role !== 'guru') return [];
  const { results } = await db.prepare(`
    select "id", "judul", "kategori", "isi", "aktif", "updated_at" from "assistant_ai_knowledge"
     where ? = 1 or "aktif" = 1 order by "kategori", "judul"`).bind(scope.admin ? 1 : 0).all();
  return (results || []).map((r) => ({ ...r, aktif: Boolean(r.aktif) }));
};

const KNOWLEDGE_FIELDS = ['judul', 'kategori', 'isi', 'aktif'];

export const saveAiKnowledge = async (db, ctx, { id, patch }) => {
  await requireAdmin(ctx);
  const fields = Object.entries(patch || {}).filter(([key]) => KNOWLEDGE_FIELDS.includes(key))
    .map(([key, value]) => [key, key === 'aktif' ? (value ? 1 : 0) : String(value ?? '')]);
  const now = nowIso();
  try {
    if (id) {
      if (!UUID.test(String(id))) throw new RpcError('NOT_FOUND', 404);
      if (!fields.length) return { id };
      const result = await db.prepare(`
        update "assistant_ai_knowledge" set ${fields.map(([key]) => `"${key}" = ?`).join(', ')}, "updated_at" = ? where "id" = ?`)
        .bind(...fields.map(([, value]) => value), now, id).run();
      if (!result.meta?.changes) throw new RpcError('NOT_FOUND', 404);
      return { id };
    }
    const row = Object.fromEntries(fields);
    const newId = crypto.randomUUID();
    await db.prepare(`
      insert into "assistant_ai_knowledge" ("id", "judul", "kategori", "isi", "aktif", "created_by", "created_at", "updated_at")
      values (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(newId, row.judul ?? '', row.kategori || 'Umum', row.isi ?? '', row.aktif ?? 1, ctx.userId, now, now).run();
    return { id: newId };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    // Pelanggaran CHECK (judul 3–120 huruf, isi 10–8.000 huruf) dilaporkan sebagai masukan tidak valid.
    if (/constraint/i.test(String(error?.message))) throw new RpcError('Judul 3–120 huruf dan isi 10–8.000 huruf.', 400);
    throw error;
  }
};

export const deleteAiKnowledge = async (db, ctx, { id }) => {
  await requireAdmin(ctx);
  if (!UUID.test(String(id || ''))) throw new RpcError('NOT_FOUND', 404);
  await db.prepare('delete from "assistant_ai_knowledge" where "id" = ?').bind(id).run();
  return { ok: true };
};

// ===== Pemakaian & evaluasi (admin) =====

export const getAssistantAiUsage = async (db, ctx) => {
  await requireAdmin(ctx);
  return monthUsage(db);
};

const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const wibStart = (date) => new Date(`${date}T00:00:00+07:00`).toISOString();
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = (sorted.length - 1) / 2;
  const value = (sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2;
  return Math.round(value * 10) / 10;
};
const round4 = (value) => Math.round((Number(value) || 0) * 10000) / 10000;

export const getAssistantAiEvaluation = async (db, ctx, { from, to }) => {
  await requireAdmin(ctx);
  if (!isDate(from) || !isDate(to) || to < from || (Date.parse(to) - Date.parse(from)) / 86400000 > 400) {
    throw new RpcError('INVALID_RANGE', 400);
  }
  const start = wibStart(from);
  const end = new Date(Date.parse(wibStart(to)) + 86400000).toISOString();

  const [usage, monthly, feedback, alerts, counts] = await db.batch([
    db.prepare(`
      select "fitur",
        sum(case when "status" in ('ok', 'uji') then 1 else 0 end) as ok,
        sum(case when "status" = 'cache' then 1 else 0 end) as cache,
        sum(case when "status" = 'gagal' then 1 else 0 end) as gagal,
        coalesce(sum("biaya_usd"), 0) as biaya_usd,
        count(distinct "user_id") as pengguna
        from "assistant_ai_usage" where "created_at" >= ? and "created_at" < ? group by "fitur" order by "fitur"`).bind(start, end),
    db.prepare(`
      select strftime('%Y-%m', "created_at", '+7 hours') as bulan, coalesce(sum("biaya_usd"), 0) as biaya_usd,
        sum(case when "status" = 'ok' then 1 else 0 end) as permintaan
        from "assistant_ai_usage" where "created_at" >= ? and "created_at" < ? group by bulan order by bulan`).bind(start, end),
    db.prepare(`
      select "jenis", sum(case when "nilai" = 1 then 1 else 0 end) as suka, sum(case when "nilai" = -1 then 1 else 0 end) as tidak_suka
        from "assistant_ai_feedback" where "updated_at" >= ? and "updated_at" < ? group by "jenis" order by "jenis"`).bind(start, end),
    db.prepare(`
      select a."created_at",
        exists (select 1 from "assistant_ai_recommendations" r, json_each(r."alert_ids") j where j."value" = a."id") as dengan_ai,
        (select min(d."created_at") from "assistant_alert_decisions" d
          where d."alert_id" = a."id" and d."keputusan" in ('ditangani', 'wali_dihubungi')) as ditindak
        from "assistant_alerts" a where a."senyap" = 0 and a."created_at" >= ? and a."created_at" < ?`).bind(start, end),
    db.prepare(`
      select (select count(*) from "wali_followups" where "created_at" >= ? and "created_at" < ?) as kontak_wali,
        (select count(distinct "santri_id") from "assistant_ai_recommendations" where "created_at" >= ? and "created_at" < ?) as saran_santri,
        (select count(*) from "assistant_ai_messages" where "role" = 'user' and "created_at" >= ? and "created_at" < ?) as percakapan`)
      .bind(start, end, start, end, start, end),
  ]);

  const groups = new Map();
  for (const row of alerts.results || []) {
    const key = row.dengan_ai ? 'dengan_saran_ai' : 'tanpa_saran_ai';
    const group = groups.get(key) || { kelompok: key, jumlah: 0, ditindaklanjuti: 0, durasi: [] };
    group.jumlah += 1;
    if (row.ditindak) {
      group.ditindaklanjuti += 1;
      group.durasi.push((Date.parse(row.ditindak) - Date.parse(row.created_at)) / 86400000);
    }
    groups.set(key, group);
  }
  const c = counts.results?.[0] || {};
  return {
    pemakaian: (usage.results || []).map((r) => ({
      fitur: r.fitur, ok: Number(r.ok) || 0, cache: Number(r.cache) || 0, gagal: Number(r.gagal) || 0,
      biaya_usd: round4(r.biaya_usd), pengguna: Number(r.pengguna) || 0,
    })),
    biaya_bulanan: (monthly.results || []).map((r) => ({ bulan: r.bulan, biaya_usd: round4(r.biaya_usd), permintaan: Number(r.permintaan) || 0 })),
    umpan_balik: (feedback.results || []).map((r) => ({ jenis: r.jenis, suka: Number(r.suka) || 0, tidak_suka: Number(r.tidak_suka) || 0 })),
    peringatan: ['dengan_saran_ai', 'tanpa_saran_ai'].filter((key) => groups.has(key)).map((key) => {
      const g = groups.get(key);
      return { kelompok: key, jumlah: g.jumlah, ditindaklanjuti: g.ditindaklanjuti, median_hari: median(g.durasi) };
    }),
    kontak_wali: Number(c.kontak_wali) || 0,
    saran_santri: Number(c.saran_santri) || 0,
    percakapan: Number(c.percakapan) || 0,
  };
};
