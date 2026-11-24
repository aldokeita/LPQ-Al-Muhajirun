// Panel "Perlu Perhatian" dan tindakan guru atasnya.
//
// Terjemahan get_assistant_attention, decide_assistant_alert, record_presence_corrections, dan
// record_alert_wali_followup dari LPQ Al-Fath Maulana. Seluruh penulisan hanya-tambah: keputusan,
// koreksi, dan kontak wali menjadi baris baru, peringatannya sendiri tidak pernah diubah.

import { RpcError } from '../rpc/santri.js';
import { addDays, hafalanJilidKeySql, isValidDate, jakartaToday } from './dates.js';
import {
  alertVisible, assistantScope, canSeeClass, classFilterParam, nowIso, parseJson, requireAssistantRole, UUID,
} from './access.js';

const daysAgoIso = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

// Satu query untuk seluruh panel. Perkara tampil sebagai episode (rangkaian peringatan dengan
// episode_key yang sama), diwakili peringatan terbarunya, dan hanya selama masalahnya masih ada:
// absen tertutup begitu santri hadir, jilid tertutup begitu naik jilid, hafalan tertutup begitu
// dinilai ulang. "Catat kontak wali" adalah tindak lanjut, bukan penyelesaian.
const ATTENTION_SQL = `
with latest as (
  select a.*, row_number() over (
           partition by a."santri_id", a."rule", a."episode_key" order by a."created_at" desc, a."id" desc) as rn
    from "assistant_alerts" a
   where a."created_at" > ? and a."senyap" = 0
     and (? is null or a."class_id" = ?)
     and (? is null or a."class_id" in (select "value" from json_each(?)))
),
episode as (
  select l.*,
    (select min(a2."created_at") from "assistant_alerts" a2
      where a2."santri_id" = l."santri_id" and a2."rule" = l."rule" and a2."episode_key" = l."episode_key"
        and a2."senyap" = 0) as first_alert_at,
    (select count(*) from "assistant_alerts" a2
      where a2."santri_id" = l."santri_id" and a2."rule" = l."rule" and a2."episode_key" = l."episode_key"
        and a2."senyap" = 0) as jumlah_pengingat,
    exists (select 1 from "assistant_alert_decisions" d join "assistant_alerts" a2 on a2."id" = d."alert_id"
             where a2."santri_id" = l."santri_id" and a2."rule" = l."rule" and a2."episode_key" = l."episode_key"
               and d."keputusan" <> 'wali_dihubungi') as decided,
    (select json_object('tanggal', wf."tanggal_kontak", 'saluran', wf."saluran", 'hasil', wf."hasil")
       from "wali_followups" wf
      where wf."santri_id" = l."santri_id"
        and wf."created_at" >= (select min(a2."created_at") from "assistant_alerts" a2
                                  where a2."santri_id" = l."santri_id" and a2."rule" = l."rule"
                                    and a2."episode_key" = l."episode_key")
      order by wf."tanggal_kontak" desc, wf."created_at" desc limit 1) as wali_kontak
    from latest l
   where l.rn = 1
)
select e."id" as alert_id, e."santri_id", s."nama_lengkap" as nama, s."nama_panggilan", e."class_id",
       c."nama_kelas", e."rule", e."tingkat", e."alasan", e."detail", e."senyap", e."created_at",
       e.first_alert_at, e.jumlah_pengingat, e.wali_kontak
  from episode e
  join "santri" s on s."id" = e."santri_id"
  join "classes" c on c."id" = e."class_id"
 where not e.decided
   and (case e."rule"
     when 'absen_beruntun' then
       not exists (select 1 from "attendance" a
                    where a."user_id" = e."santri_id" and a."attendance_date" > json_extract(e."detail", '$.last_absent')
                      and coalesce(a."status", '') <> 'Tidak Hadir')
       and not exists (select 1 from "attendance_presence_corrections" pc
                        where pc."santri_id" = e."santri_id" and pc."tanggal" > json_extract(e."detail", '$.last_absent'))
     when 'jilid_lama' then s."jilid" is json_extract(e."detail", '$.jilid')
     when 'hafalan_wajib_belum_lulus' then
       s."jilid" is json_extract(e."detail", '$.jilid') and e."created_at" > ?
       and exists (select 1 from "hafalan_items" hi
                    where hi."is_active" = 1 and hi."program_scope" = 'TPQ' and trim(hi."jilid") = ${hafalanJilidKeySql('s."jilid"')}
                      and not exists (select 1 from "hafalan_progress" hp
                                       where hp."santri_id" = e."santri_id" and hp."item_id" = hi."id" and hp."status" = 'lulus'))
     when 'hafalan_macet' then
       e."created_at" > ?
       and exists (select 1 from "hafalan_progress" hp
                    where hp."santri_id" = e."santri_id" and hp."status" in ('proses', 'ulang')
                      and date(hp."updated_at", '+7 hours')
                          < date(e."ref_date", '-' || coalesce(json_extract(e."detail", '$.max_days'), 30) || ' days'))
     else e."created_at" > ?
   end)
 order by case e."tingkat" when 'tinggi' then 0 when 'sedang' then 1 else 2 end, e."created_at" desc`;

export const loadAttentionItems = async (db, scope, classId = null) => {
  const classes = classFilterParam(scope);
  const sevenDays = daysAgoIso(7);
  const { results } = await db.prepare(ATTENTION_SQL)
    .bind(daysAgoIso(60), classId, classId, classes, classes, sevenDays, sevenDays, sevenDays)
    .all();
  return (results || []).map((row) => ({
    ...row,
    detail: parseJson(row.detail, {}),
    wali_kontak: parseJson(row.wali_kontak, null),
    senyap: Boolean(row.senyap),
    jumlah_pengingat: Number(row.jumlah_pengingat) || 0,
  }));
};

export const getAssistantAttention = async (db, ctx, { classId = null } = {}) => {
  const scope = await assistantScope(ctx);
  if (classId !== null && classId !== undefined && !canSeeClass(scope, classId)) {
    throw new RpcError('CLASS_ACCESS_DENIED', 403);
  }
  requireAssistantRole(scope);
  if (scope.blind) return { items: [], senyap_tersimpan: 0, mode_senyap: true };

  const items = await loadAttentionItems(db, scope, classId ?? null);
  let silentCount = 0;
  if (scope.admin) {
    const row = await db.prepare(`
      select count(*) as n from (
        select distinct "santri_id", "rule", "episode_key" from "assistant_alerts"
         where "senyap" = 1 and "created_at" > ? and (? is null or "class_id" = ?))`)
      .bind(daysAgoIso(60), classId ?? null, classId ?? null).first();
    silentCount = Number(row?.n) || 0;
  }
  return { items, senyap_tersimpan: silentCount, mode_senyap: scope.silent };
};

const loadVisibleAlert = async (db, scope, alertId) => {
  if (!UUID.test(String(alertId || ''))) throw new RpcError('ALERT_NOT_FOUND', 404);
  const alert = await db.prepare('select * from "assistant_alerts" where "id" = ?').bind(alertId).first();
  if (!alert || !alertVisible(scope, alert)) throw new RpcError('ALERT_NOT_FOUND', 404);
  return alert;
};

const cleanText = (value) => {
  const text = String(value ?? '').trim();
  return text ? text : null;
};

export const decideAssistantAlert = async (db, ctx, { alertId, keputusan, catatan }) => {
  const scope = await assistantScope(ctx);
  const alert = await loadVisibleAlert(db, scope, alertId);
  if (!['ditangani', 'diabaikan', 'peringatan_keliru'].includes(keputusan)) throw new RpcError('INVALID_DECISION', 400);
  const note = cleanText(catatan);
  if (keputusan === 'diabaikan' && !note) throw new RpcError('REASON_REQUIRED', 400);
  if (note && note.length > 500) throw new RpcError('CATATAN_TOO_LONG', 400);

  const id = crypto.randomUUID();
  await db.prepare(`insert into "assistant_alert_decisions" ("id", "alert_id", "keputusan", "catatan", "diputuskan_oleh", "created_at")
                    values (?, ?, ?, ?, ?, ?)`)
    .bind(id, alert.id, keputusan, note, ctx.userId, nowIso()).run();
  return id;
};

// Koreksi "sebenarnya hadir" untuk tanggal-tanggal di peringatan absen. Bila koreksi memutus
// rangkaian absen di bawah ambang, peringatan otomatis ditandai "peringatan_keliru".
export const recordPresenceCorrections = async (db, ctx, { alertId, dates, keterangan }) => {
  const scope = await assistantScope(ctx);
  const alert = await loadVisibleAlert(db, scope, alertId);
  if (alert.rule !== 'absen_beruntun') throw new RpcError('NOT_ATTENDANCE_ALERT', 400);
  if (!Array.isArray(dates) || dates.length === 0 || dates.length > 60 || !dates.every(isValidDate)) {
    throw new RpcError('INVALID_DATES', 400);
  }
  const note = cleanText(keterangan);
  if (note && note.length > 300) throw new RpcError('KETERANGAN_TOO_LONG', 400);

  const detail = parseJson(alert.detail, {});
  const absent = (Array.isArray(detail.absent_dates) ? detail.absent_dates : []).slice().sort().reverse();
  if (dates.some((d) => !absent.includes(d))) throw new RpcError('DATE_NOT_IN_ALERT', 400);

  const now = nowIso();
  const rows = [...new Set(dates)].map((tanggal) => ({
    id: crypto.randomUUID(), santri_id: alert.santri_id, class_id: alert.class_id, tanggal, keterangan: note,
    alert_id: alert.id, dikoreksi_oleh: ctx.userId, created_at: now,
  }));
  const insert = await db.prepare(`
    insert or ignore into "attendance_presence_corrections"
      ("id", "santri_id", "class_id", "tanggal", "keterangan", "alert_id", "dikoreksi_oleh", "created_at")
    select json_extract(j."value", '$.id'), json_extract(j."value", '$.santri_id'), json_extract(j."value", '$.class_id'),
           json_extract(j."value", '$.tanggal'), json_extract(j."value", '$.keterangan'), json_extract(j."value", '$.alert_id'),
           json_extract(j."value", '$.dikoreksi_oleh'), json_extract(j."value", '$.created_at')
      from json_each(?) j`)
    .bind(JSON.stringify(rows)).run();
  const inserted = Number(insert?.meta?.changes ?? 0);

  // Hitung ulang rangkaian absen dari tanggal absen terakhir ke belakang.
  const { results } = await db.prepare(`
    select "tanggal" from "attendance_presence_corrections"
     where "santri_id" = ? and "tanggal" in (select "value" from json_each(?))`)
    .bind(alert.santri_id, JSON.stringify(absent)).all();
  const corrected = new Set((results || []).map((r) => r.tanggal));
  let remaining = 0;
  for (const day of absent) {
    if (corrected.has(day)) break;
    remaining += 1;
  }

  let closed = false;
  if (remaining < (Number(detail.threshold) || 3)) {
    await db.prepare(`insert into "assistant_alert_decisions" ("id", "alert_id", "keputusan", "catatan", "diputuskan_oleh", "created_at")
                      values (?, ?, 'peringatan_keliru', ?, ?, ?)`)
      .bind(crypto.randomUUID(), alert.id, 'Otomatis: guru mengoreksi santri sebenarnya hadir.', ctx.userId, nowIso()).run();
    closed = true;
  }
  return { koreksi_baru: inserted, sisa_absen: remaining, ditutup: closed };
};

// Satu kontak wali untuk satu atau beberapa perkara santri yang sama. Kontak dicatat sekali,
// dikaitkan ke perkara pertama, agar indikator tindak lanjut tidak terhitung ganda.
export const recordAlertWaliFollowup = async (db, ctx, { alertIds, tanggalKontak, saluran, hasil, catatan }) => {
  const scope = await assistantScope(ctx);
  if (!Array.isArray(alertIds) || alertIds.length === 0 || alertIds.length > 20
    || !alertIds.every((id) => UUID.test(String(id)))) throw new RpcError('ALERT_NOT_FOUND', 404);

  const { results } = await db.prepare('select * from "assistant_alerts" where "id" in (select "value" from json_each(?))')
    .bind(JSON.stringify(alertIds)).all();
  const byId = new Map((results || []).map((a) => [a.id, a]));
  const alerts = alertIds.map((id) => byId.get(id));
  if (alerts.some((a) => !a || !alertVisible(scope, a))) throw new RpcError('ALERT_NOT_FOUND', 404);
  const [first] = alerts;
  if (alerts.some((a) => a.santri_id !== first.santri_id)) throw new RpcError('ALERTS_DIFFERENT_SANTRI', 400);

  const today = jakartaToday();
  const firstDay = addDays(new Date(Date.parse(first.created_at) + 7 * 60 * 60 * 1000).toISOString().slice(0, 10), -14);
  if (!isValidDate(tanggalKontak) || tanggalKontak > today || tanggalKontak < firstDay) {
    throw new RpcError('INVALID_CONTACT_DATE', 400);
  }
  if (!['whatsapp', 'telepon', 'tatap_muka', 'lainnya'].includes(saluran)
    || !['terhubung', 'tidak_merespons', 'janji_hadir', 'lainnya'].includes(hasil)) {
    throw new RpcError('INVALID_FOLLOWUP', 400);
  }
  const note = cleanText(catatan);
  if (note && note.length > 500) throw new RpcError('CATATAN_TOO_LONG', 400);

  const id = crypto.randomUUID();
  const now = nowIso();
  const decisions = alerts.map((a) => ({ id: crypto.randomUUID(), alert_id: a.id }));
  await db.batch([
    db.prepare(`insert into "wali_followups"
                  ("id", "santri_id", "class_id", "guru_id", "alert_id", "tanggal_kontak", "saluran", "hasil", "catatan", "created_at")
                values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, first.santri_id, first.class_id, ctx.userId, first.id, tanggalKontak, saluran, hasil, note, now),
    db.prepare(`insert into "assistant_alert_decisions" ("id", "alert_id", "keputusan", "catatan", "diputuskan_oleh", "created_at")
                select json_extract(j."value", '$.id'), json_extract(j."value", '$.alert_id'), 'wali_dihubungi', null, ?, ?
                  from json_each(?) j`)
      .bind(ctx.userId, now, JSON.stringify(decisions)),
  ]);
  return id;
};
