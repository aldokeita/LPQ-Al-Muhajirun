// Pemeriksa aturan harian "Perlu Perhatian".
//
// Terjemahan run_assistant_rules dan assistant_insert_alert dari LPQ Al-Fath Maulana. Aturan,
// bukan AI, yang menentukan santri mana perlu perhatian. Hanya santri TPQ anak (kategori 'Anak')
// yang aktif dan punya kelas aktif yang diperiksa.
//
//   Harian : absen_beruntun, jilid_lama.
//   Pekanan (hari Jumat, atau dipaksa admin): kehadiran_bulanan, hafalan_macet,
//            hafalan_wajib_belum_lulus, murojaah_belum_ditinjau.
//
// Versi Postgres memeriksa santri satu per satu dengan beberapa query masing-masing. Worker
// gratis hanya boleh 50 query D1 per pemanggilan dan 10 ms CPU, jadi bentuknya dibalik:
// semua santri dihitung sekaligus dengan query agregat — pekerjaan beratnya berjalan di SQLite,
// bukan di CPU Worker — lalu peringatan baru dimasukkan beberapa puluh sekaligus lewat json_each.
// Seluruh pemeriksaan memakai sekitar enam query, berapa pun jumlah santrinya.
//
// Satu perbedaan yang disengaja: absensi berstatus 'Tidak Hadir' tidak dihitung hadir. Versi
// asalnya menganggap baris absensi apa pun sebagai kehadiran.

import { RpcError } from '../rpc/santri.js';
import {
  addDays, countHolidaysAfter, daysBetween, formatDmy, hafalanJilidKeySql, isoWeekLabel, isoWeekday,
  isValidDate, jakartaToday, maxDate, schoolDaySql, schoolDaysBetween,
} from './dates.js';
import { loadSettings, requireAdmin } from './settings.js';

const STREAK_WINDOW_DAYS = 120;
const STREAK_MAX_SESSIONS = 60;
// D1 menolak pernyataan di atas 100 KB, dan satu pemanggilan hanya boleh 50 query. Peringatan
// dikirim dalam potongan berdasarkan ukuran, paling banyak MAX_INSERT_STATEMENTS potongan. Bila
// ada sisa (hanya mungkin pada pemeriksaan pertama atas data yang lama tertunda), sisanya tertangkap
// pada pemeriksaan berikutnya karena dedupe membuatnya tetap dihitung sebagai calon baru.
const INSERT_CHUNK_CHARS = 80_000;
const MAX_INSERT_STATEMENTS = 30;

export const RULE_AREA = {
  absen_beruntun: 'kehadiran',
  kehadiran_bulanan: 'kehadiran',
  jilid_lama: 'jilid',
  hafalan_macet: 'hafalan',
  hafalan_wajib_belum_lulus: 'hafalan',
};
// Muroja'ah belum ditinjau adalah urusan guru, bukan kondisi santri, jadi tidak menaikkan tingkat.
export const ruleArea = (rule) => RULE_AREA[rule] || 'lainnya';

// Hadir = ada tap absensi (selain 'Tidak Hadir') atau koreksi "sebenarnya hadir" pada tanggal itu.
export const presentDatesSql = (santriColumn, fromParam, toParam) => `
  select a."attendance_date" as d from "attendance" a
   where a."user_id" = ${santriColumn} and a."attendance_date" between ${fromParam} and ${toParam}
     and coalesce(a."status", '') <> 'Tidak Hadir'
  union
  select c."tanggal" as d from "attendance_presence_corrections" c
   where c."santri_id" = ${santriColumn} and c."tanggal" between ${fromParam} and ${toParam}`;

const ROSTER_FROM = `
  from "santri" s
  join "class_memberships" cm on cm."santri_id" = s."id" and cm."status" = 'active'
  join "classes" c on c."id" = cm."class_id" and c."deleted_at" is null
 where s."kategori" = 'Anak' and s."status" = 'Aktif' and s."deleted_at" is null
   and cm."start_date" <= ?`;

const loadDailyRows = (db, ref, schoolDays) => {
  const windowStart = addDays(ref, -STREAK_WINDOW_DAYS);
  const days = JSON.stringify(schoolDays);
  return db.prepare(`
    select s."id" as santri_id, s."jilid", s."tanggal_pendaftaran", cm."class_id", cm."start_date",
      (select max(date(jh."changed_at", '+7 hours')) from "jilid_history" jh
        where jh."santri_id" = s."id" and jh."to_jilid" = s."jilid") as jilid_changed,
      (select max(p.d) from (${presentDatesSql('s."id"', '?', '?')}) p
        where ${schoolDaySql('p.d')}) as last_present
    ${ROSTER_FROM}`)
    .bind(windowStart, ref, windowStart, ref, days, ref)
    .all();
};

const loadWeeklyRows = (db, ref, schoolDays, settings) => {
  const days = JSON.stringify(schoolDays);
  const monthStart = addDays(ref, -27);
  const prosesCutoff = addDays(ref, -settings.hafalan.proses_max_days);
  const reviewCutoff = addDays(ref, -settings.hafalan.murojaah_review_max_days);
  const key = hafalanJilidKeySql('s."jilid"');
  return db.prepare(`
    select s."id" as santri_id,
      (select count(distinct p.d) from (${presentDatesSql('s."id"', 'max(cm."start_date", ?)', '?')}) p
        where ${schoolDaySql('p.d')}) as present_28,
      (select count(*) from "hafalan_progress" hp
        where hp."santri_id" = s."id" and hp."status" in ('proses', 'ulang')
          and date(hp."updated_at", '+7 hours') < ?) as macet_count,
      (select json_group_array(x."item_name") from (
          select hp."item_name" from "hafalan_progress" hp
           where hp."santri_id" = s."id" and hp."status" in ('proses', 'ulang') and hp."item_name" is not null
             and date(hp."updated_at", '+7 hours') < ?
           order by hp."updated_at" limit 5) x) as macet_items,
      (select count(*) from "hafalan_items" hi
        where hi."is_active" = 1 and hi."program_scope" = 'TPQ' and trim(hi."jilid") = ${key}
          and not exists (select 1 from "hafalan_progress" hp
                           where hp."santri_id" = s."id" and hp."item_id" = hi."id" and hp."status" = 'lulus')) as wajib_count,
      (select json_group_array(x."item_name") from (
          select hi."item_name" from "hafalan_items" hi
           where hi."is_active" = 1 and hi."program_scope" = 'TPQ' and trim(hi."jilid") = ${key}
             and not exists (select 1 from "hafalan_progress" hp
                              where hp."santri_id" = s."id" and hp."item_id" = hi."id" and hp."status" = 'lulus')
           order by hi."item_order" limit 5) x) as wajib_items,
      exists (select 1 from "hafalan_progress" hp join "hafalan_items" hi on hi."id" = hp."item_id"
               where hp."santri_id" = s."id" and hi."program_scope" = 'TPQ' and trim(hi."jilid") = ${key}) as wajib_dicatat,
      (select count(*) from "murojaah_submissions" ms
        where ms."santri_id" = s."id" and ms."status" = 'menunggu'
          and date(coalesce(ms."submitted_at", ms."created_at"), '+7 hours') < ?) as murojaah_count
    ${ROSTER_FROM}`)
    .bind(monthStart, ref, monthStart, ref, days, prosesCutoff, prosesCutoff, reviewCutoff, ref)
    .all();
};

const parseList = (text) => {
  try {
    const list = JSON.parse(text || '[]');
    return Array.isArray(list) ? list.filter((x) => x !== null).slice(0, 5) : [];
  } catch {
    return [];
  }
};

// Daftar calon peringatan untuk satu santri, urut sama dengan versi Postgres: urutan ini
// menentukan kenaikan tingkat bila santri bermasalah di dua bidang dalam satu pemeriksaan.
export const evaluateSantri = ({ row, weeklyRow, ref, weekly, week, settings, holidays, holidayList }) => {
  const candidates = [];
  const { attendance, jilid, hafalan } = settings;
  const schoolDays = settings.school_days;

  // ===== absen_beruntun =====
  const sched = schoolDaysBetween(maxDate(row.start_date, addDays(ref, -STREAK_WINDOW_DAYS)), ref, schoolDays, holidays)
    .slice(-STREAK_MAX_SESSIONS);
  const absent = sched.filter((d) => !row.last_present || d > row.last_present).reverse();
  const streak = absent.length;
  if (streak >= attendance.consecutive_sessions) {
    const k = Math.floor((streak - attendance.consecutive_sessions) / attendance.repeat_every_sessions);
    const first = absent[streak - 1];
    candidates.push({
      rule: 'absen_beruntun',
      tingkat: streak >= attendance.high_consecutive_sessions ? 'tinggi' : (k > 0 ? 'rendah' : 'sedang'),
      alasan: `Tidak hadir ${streak} sesi terjadwal berturut-turut (${formatDmy(first)} s.d. ${formatDmy(absent[0])}).`,
      detail: {
        streak, absent_dates: absent, episode_start: first, last_absent: absent[0],
        threshold: attendance.consecutive_sessions,
      },
      dedupe: `absen:${first}:${k}`,
      episode: `absen:${first}`,
    });
  }

  // ===== jilid_lama =====
  let jilidDays = null;
  let threshold = null;
  const currentJilid = typeof row.jilid === 'string' ? row.jilid : null;
  if (currentJilid && currentJilid.trim()) {
    const since = row.jilid_changed || row.start_date || row.tanggal_pendaftaran || null;
    if (since && since <= ref) {
      jilidDays = daysBetween(since, ref) - countHolidaysAfter(since, ref, holidayList);
      threshold = Number.isInteger(jilid.per_jilid?.[currentJilid]) ? jilid.per_jilid[currentJilid] : jilid.default_days;
      if (jilidDays > threshold) {
        const k = Math.floor((jilidDays - threshold - 1) / jilid.repeat_every_days);
        candidates.push({
          rule: 'jilid_lama',
          tingkat: k > 0 ? 'rendah' : 'sedang',
          alasan: `Sudah ${jilidDays} hari di ${currentJilid} tanpa naik jilid (batas ${threshold} hari).`,
          detail: { jilid: currentJilid, days: jilidDays, since, threshold },
          dedupe: `jilid:${currentJilid}:${since}:${k}`,
          episode: `jilid:${currentJilid}:${since}`,
        });
      }
    }
  }

  if (!weekly || !weeklyRow) return candidates;
  const pekan = `pekan:${week}`;

  // ===== kehadiran_bulanan (4 pekan terakhir) =====
  const total = schoolDaysBetween(maxDate(row.start_date, addDays(ref, -27)), ref, schoolDays, holidays).length;
  const present = Number(weeklyRow.present_28) || 0;
  if (total >= 5 && present * 100 < attendance.monthly_min_percent * total) {
    const percent = Math.trunc((present * 100) / total);
    candidates.push({
      rule: 'kehadiran_bulanan',
      tingkat: 'sedang',
      alasan: `Kehadiran 4 pekan terakhir ${percent}% (${present} dari ${total} sesi), di bawah standar ${attendance.monthly_min_percent}%.`,
      detail: { present, total, percent, min_percent: attendance.monthly_min_percent },
      dedupe: pekan,
      episode: pekan,
    });
  }

  // ===== hafalan_macet =====
  const macet = Number(weeklyRow.macet_count) || 0;
  if (macet > 0) {
    candidates.push({
      rule: 'hafalan_macet',
      tingkat: 'sedang',
      alasan: `${macet} item hafalan berstatus proses/ulang lebih dari ${hafalan.proses_max_days} hari.`,
      detail: { count: macet, items: parseList(weeklyRow.macet_items), max_days: hafalan.proses_max_days },
      dedupe: pekan,
      episode: pekan,
    });
  }

  // ===== hafalan_wajib_belum_lulus (setelah melewati sebagian batas jilid) =====
  // Hanya bila guru sudah mulai mencatat hafalan jilid ini; tanpa catatan, yang kosong adalah
  // datanya, bukan hafalan santrinya.
  const wajib = Number(weeklyRow.wajib_count) || 0;
  if (jilidDays !== null && threshold !== null && /^Jilid ?[1-6][A-C]?$/.test(currentJilid.trim())
    && jilidDays * 100 >= threshold * hafalan.required_items_after_percent
    && wajib > 0 && Number(weeklyRow.wajib_dicatat) === 1) {
    candidates.push({
      rule: 'hafalan_wajib_belum_lulus',
      tingkat: 'sedang',
      alasan: `${wajib} item hafalan wajib ${currentJilid} belum lulus, sudah ${jilidDays} dari ${threshold} hari batas jilid.`,
      detail: { count: wajib, items: parseList(weeklyRow.wajib_items), jilid: currentJilid },
      dedupe: pekan,
      episode: pekan,
    });
  }

  // ===== murojaah_belum_ditinjau =====
  const murojaah = Number(weeklyRow.murojaah_count) || 0;
  if (murojaah > 0) {
    candidates.push({
      rule: 'murojaah_belum_ditinjau',
      tingkat: 'rendah',
      alasan: `${murojaah} setoran muroja'ah menunggu ditinjau lebih dari ${hafalan.murojaah_review_max_days} hari.`,
      detail: { count: murojaah, max_days: hafalan.murojaah_review_max_days },
      dedupe: pekan,
      episode: pekan,
    });
  }

  return candidates;
};

const changesOf = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

export const runAssistantRules = async (db, { ctx = null, ref: requestedRef = null, weekly: requestedWeekly = null } = {}) => {
  // Admin boleh menjalankan manual; jadwal cron Worker memanggil tanpa ctx. Selain itu ditolak.
  if (ctx) await requireAdmin(ctx);

  const today = jakartaToday();
  const ref = requestedRef ?? addDays(today, -1);
  if (!isValidDate(ref)) throw new RpcError('INVALID_DATE', 400);
  if (ref > today) throw new RpcError('FUTURE_DATE_NOT_ALLOWED', 400);
  const weekly = typeof requestedWeekly === 'boolean' ? requestedWeekly : isoWeekday(ref) === 5;
  const week = isoWeekLabel(ref);

  const { id: settingsId, settings } = await loadSettings(db);
  const silent = settings.silent_mode ? 1 : 0;

  const [holidayRows, daily, weeklyResult] = await Promise.all([
    db.prepare('select "date" from "academic_calendar" where "is_holiday" = 1 order by "date"').all(),
    loadDailyRows(db, ref, settings.school_days),
    weekly ? loadWeeklyRows(db, ref, settings.school_days, settings) : Promise.resolve({ results: [] }),
  ]);
  const holidayList = (holidayRows.results || []).map((r) => r.date);
  const holidays = new Set(holidayList);
  const weeklyById = new Map((weeklyResult.results || []).map((r) => [r.santri_id, r]));
  const rows = daily.results || [];

  const candidates = [];
  for (const row of rows) {
    for (const candidate of evaluateSantri({
      row, weeklyRow: weeklyById.get(row.santri_id), ref, weekly, week, settings, holidays, holidayList,
    })) {
      candidates.push({ ...candidate, santri_id: row.santri_id, class_id: row.class_id });
    }
  }

  const { inserted, deferred } = candidates.length
    ? await insertAlerts(db, candidates, { silent, ref, settingsId })
    : { inserted: 0, deferred: 0 };

  return {
    ref_date: ref, weekly, santri_diperiksa: rows.length, peringatan_baru: inserted, ditunda: deferred,
    senyap: Boolean(silent),
  };
};

// Terjemahan assistant_insert_alert untuk banyak calon sekaligus.
//   - 'rendah' berarti pengingat ulang; peringatan pertama dalam satu episode minimal 'sedang'.
//   - Naik menjadi 'tinggi' bila santri yang sama sedang punya peringatan terbuka di bidang lain
//     dalam 7 hari terakhir — termasuk yang baru dibuat di pemeriksaan ini, seperti versi asalnya
//     yang menyisipkan satu per satu.
const insertAlerts = async (db, candidates, { silent, ref, settingsId }) => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const episodeKeys = [...new Set(candidates.map((c) => c.episode))];
  const [recentOpen, existing] = await Promise.all([
    db.prepare(`
      select a."santri_id", a."rule" from "assistant_alerts" a
       where a."senyap" = ? and a."created_at" > ?
         and not exists (select 1 from "assistant_alert_decisions" d
                          join "assistant_alerts" a2 on a2."id" = d."alert_id"
                         where a2."santri_id" = a."santri_id" and a2."rule" = a."rule"
                           and a2."episode_key" = a."episode_key")`)
      .bind(silent, sevenDaysAgo).all(),
    db.prepare(`
      select "santri_id", "rule", "episode_key", "dedupe_key" from "assistant_alerts"
       where "senyap" = ? and "episode_key" in (select "value" from json_each(?))`)
      .bind(silent, JSON.stringify(episodeKeys)).all(),
  ]);

  const openAreas = new Map();
  const addArea = (santriId, area) => {
    if (area === 'lainnya') return;
    if (!openAreas.has(santriId)) openAreas.set(santriId, new Set());
    openAreas.get(santriId).add(area);
  };
  for (const r of recentOpen.results || []) addArea(r.santri_id, ruleArea(r.rule));

  const episodes = new Set();
  const dedupes = new Set();
  for (const r of existing.results || []) {
    episodes.add(`${r.santri_id}|${r.rule}|${r.episode_key}`);
    dedupes.add(`${r.santri_id}|${r.rule}|${r.dedupe_key}`);
  }

  const now = new Date().toISOString();
  const rows = [];
  for (const c of candidates) {
    if (dedupes.has(`${c.santri_id}|${c.rule}|${c.dedupe}`)) continue;
    let tingkat = c.tingkat;
    if (tingkat === 'rendah' && c.rule !== 'murojaah_belum_ditinjau' && !episodes.has(`${c.santri_id}|${c.rule}|${c.episode}`)) {
      tingkat = 'sedang';
    }
    const area = ruleArea(c.rule);
    const others = openAreas.get(c.santri_id);
    if (area !== 'lainnya' && others && [...others].some((a) => a !== area)) tingkat = 'tinggi';

    rows.push({
      id: crypto.randomUUID(), santri_id: c.santri_id, class_id: c.class_id, rule: c.rule, tingkat,
      alasan: c.alasan, detail: JSON.stringify(c.detail), dedupe_key: c.dedupe, episode_key: c.episode,
      senyap: silent, ref_date: ref, settings_id: settingsId, created_at: now,
    });
    dedupes.add(`${c.santri_id}|${c.rule}|${c.dedupe}`);
    episodes.add(`${c.santri_id}|${c.rule}|${c.episode}`);
    addArea(c.santri_id, area);
  }

  const chunks = [];
  let current = [];
  let size = 0;
  for (const row of rows) {
    const length = JSON.stringify(row).length;
    if (current.length && size + length > INSERT_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += length;
  }
  if (current.length) chunks.push(current);

  let inserted = 0;
  for (const chunk of chunks.slice(0, MAX_INSERT_STATEMENTS)) {
    const result = await db.prepare(`
      insert or ignore into "assistant_alerts"
        ("id", "santri_id", "class_id", "rule", "tingkat", "alasan", "detail", "dedupe_key", "episode_key",
         "senyap", "ref_date", "settings_id", "created_at")
      select json_extract(j."value", '$.id'), json_extract(j."value", '$.santri_id'), json_extract(j."value", '$.class_id'),
             json_extract(j."value", '$.rule'), json_extract(j."value", '$.tingkat'), json_extract(j."value", '$.alasan'),
             json_extract(j."value", '$.detail'), json_extract(j."value", '$.dedupe_key'), json_extract(j."value", '$.episode_key'),
             json_extract(j."value", '$.senyap'), json_extract(j."value", '$.ref_date'), json_extract(j."value", '$.settings_id'),
             json_extract(j."value", '$.created_at')
        from json_each(?) j`)
      .bind(JSON.stringify(chunk))
      .run();
    inserted += changesOf(result);
  }
  return { inserted, deferred: chunks.slice(MAX_INSERT_STATEMENTS).reduce((n, c) => n + c.length, 0) };
};
