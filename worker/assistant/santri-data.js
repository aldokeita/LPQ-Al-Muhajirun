// Data santri untuk asisten: ringkasan infografik, kehadiran sebulan, profil lengkap, dan roster.
//
// Terjemahan get_assistant_santri_snapshot, get_assistant_santri_month_attendance,
// get_assistant_santri_profile, get_assistant_ai_classes, dan get_assistant_class_roster dari
// LPQ Al-Fath Maulana. Semuanya hanya membaca. Akses mengikuti panel: admin semua santri, guru
// hanya santri di kelasnya, dan guru tidak mendapat apa pun selama mode senyap.
//
// Jumlah query dijaga tetap, berapa pun jumlah santrinya: AI membaca satu kelas utuh dalam satu
// pemanggilan Worker, dan paket gratis hanya mengizinkan 50 query D1 per pemanggilan.

import { RpcError } from '../rpc/santri.js';
import {
  addDays, countHolidaysAfter, daysBetween, hafalanJilidKey, hafalanJilidKeySql, jakartaToday, maxDate,
  schoolDaysBetween,
} from './dates.js';
import { assistantScope, canSeeClass, classFilterParam, parseJson, requireAssistantRole, UUID } from './access.js';

const loadHolidays = async (db) => {
  const { results } = await db.prepare('select "date" from "academic_calendar" where "is_holiday" = 1 order by "date"').all();
  const list = (results || []).map((r) => r.date);
  return { list, set: new Set(list) };
};

// Status satu tanggal: hadir, terlambat, koreksi ("sebenarnya hadir"), atau absen. Bila ada lebih
// dari satu tap, yang paling awal dipakai, seperti versi asalnya.
const sessionStatus = (taps, corrected) => {
  const tap = (taps || []).filter((t) => (t.status || '') !== 'Tidak Hadir')
    .sort((a, b) => String(a.check_in_time ?? '￿').localeCompare(String(b.check_in_time ?? '￿')))[0];
  if (tap) return /terlambat/i.test(tap.status || '') ? 'terlambat' : 'hadir';
  return corrected ? 'koreksi' : 'absen';
};

const groupTaps = (rows) => {
  const map = new Map();
  for (const row of rows || []) {
    const key = `${row.user_id}|${row.attendance_date}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
};

const jilidStanding = (row, ref, settings, holidayList) => {
  const result = { jilid_sejak: null, jilid_hari: null, jilid_batas: null };
  if (!row.jilid || !String(row.jilid).trim()) return result;
  const since = row.jilid_changed || row.start_date || row.tanggal_pendaftaran || null;
  result.jilid_sejak = since;
  if (since && since <= ref) result.jilid_hari = daysBetween(since, ref) - countHolidaysAfter(since, ref, holidayList);
  const custom = settings.jilid.per_jilid?.[row.jilid];
  result.jilid_batas = Number.isInteger(custom) ? custom : settings.jilid.default_days;
  return result;
};

export const loadSnapshots = async (db, scope, santriIds) => {
  const ids = JSON.stringify(santriIds);
  const classes = classFilterParam(scope);
  const ref = addDays(jakartaToday(), -1);
  const windowStart = addDays(ref, -40);
  const key = hafalanJilidKeySql('s."jilid"');

  const [rosterResult, taps, corrections, hafalan, holidays] = await Promise.all([
    db.prepare(`
      select s."id", s."jilid", s."tanggal_pendaftaran", s."no_hp_ortu", cm."class_id", cm."start_date",
        (select max(date(jh."changed_at", '+7 hours')) from "jilid_history" jh
          where jh."santri_id" = s."id" and jh."to_jilid" = s."jilid") as jilid_changed,
        (select count(*) from "murojaah_submissions" ms
          where ms."santri_id" = s."id" and ms."status" = 'menunggu') as murojaah_menunggu
        from "santri" s
        join "class_memberships" cm on cm."santri_id" = s."id" and cm."status" = 'active'
       where s."id" in (select "value" from json_each(?)) and s."deleted_at" is null
         and (? is null or cm."class_id" in (select "value" from json_each(?)))`)
      .bind(ids, classes, classes).all(),
    db.prepare(`
      select "user_id", "attendance_date", "status", "check_in_time" from "attendance"
       where "user_id" in (select "value" from json_each(?)) and "attendance_date" between ? and ?`)
      .bind(ids, windowStart, ref).all(),
    db.prepare(`
      select "santri_id", "tanggal" from "attendance_presence_corrections"
       where "santri_id" in (select "value" from json_each(?)) and "tanggal" between ? and ?`)
      .bind(ids, windowStart, ref).all(),
    db.prepare(`
      select s."id" as santri_id, count(hi."id") as total,
             coalesce(sum(hp."status" = 'lulus'), 0) as lulus,
             coalesce(sum(hp."status" in ('proses', 'ulang')), 0) as proses,
             count(hp."item_id") as dicatat,
             (select hi2."category" from "hafalan_progress" hp2 join "hafalan_items" hi2 on hi2."id" = hp2."item_id"
               where hp2."santri_id" = s."id" and hp2."status" in ('proses', 'ulang')
                 and hi2."is_active" = 1 and hi2."program_scope" = 'TPQ' and trim(hi2."jilid") = ${key}
               order by hp2."updated_at" limit 1) as kategori_proses
        from "santri" s
        join "hafalan_items" hi on hi."is_active" = 1 and hi."program_scope" = 'TPQ' and trim(hi."jilid") = ${key}
        left join "hafalan_progress" hp on hp."item_id" = hi."id" and hp."santri_id" = s."id"
       where s."id" in (select "value" from json_each(?))
       group by s."id"`)
      .bind(ids).all(),
    loadHolidays(db),
  ]);

  const tapsByDay = groupTaps(taps.results);
  const correctedDays = new Set((corrections.results || []).map((c) => `${c.santri_id}|${c.tanggal}`));
  const hafalanById = new Map((hafalan.results || []).map((h) => [h.santri_id, h]));
  const { settings } = scope;

  return (rosterResult.results || []).map((row) => {
    const start = row.start_date || row.tanggal_pendaftaran || addDays(ref, -120);
    const statusOn = (d) => sessionStatus(tapsByDay.get(`${row.id}|${d}`), correctedDays.has(`${row.id}|${d}`));
    const pulse = schoolDaysBetween(maxDate(start, windowStart), ref, settings.school_days, holidays.set)
      .slice(-10).map((d) => ({ t: d, s: statusOn(d) }));
    const month = schoolDaysBetween(maxDate(start, addDays(ref, -27)), ref, settings.school_days, holidays.set);
    const standing = jilidStanding(row, ref, settings, holidays.list);

    let hafalanSummary = null;
    if (hafalanJilidKey(row.jilid)) {
      const h = hafalanById.get(row.id);
      hafalanSummary = {
        total: Number(h?.total) || 0,
        lulus: Number(h?.lulus) || 0,
        proses: Number(h?.proses) || 0,
        dicatat: Number(h?.dicatat) || 0,
        kategori_proses: h?.kategori_proses ?? null,
      };
    }

    return {
      santri_id: row.id,
      jilid: row.jilid,
      ...standing,
      sesi_terakhir: pulse,
      hadir_4pekan: month.filter((d) => statusOn(d) !== 'absen').length,
      sesi_4pekan: month.length,
      hafalan: hafalanSummary,
      murojaah_menunggu: Number(row.murojaah_menunggu) || 0,
      no_hp_wali: String(row.no_hp_ortu ?? '').trim() || null,
    };
  });
};

export const getAssistantSantriSnapshot = async (db, ctx, { santriIds }) => {
  const scope = await assistantScope(ctx);
  requireAssistantRole(scope);
  const ids = Array.isArray(santriIds) ? santriIds.filter((id) => UUID.test(String(id))) : [];
  if (ids.length > 200) throw new RpcError('TOO_MANY_SANTRI', 400);
  if (scope.blind || ids.length === 0) return [];
  return loadSnapshots(db, scope, ids);
};

// Kehadiran satu santri sepanjang satu bulan untuk kartu profil yang dibagikan ke wali. Sesi
// dihitung dari awal bulan (atau tanggal masuk kelas bila lebih akhir) sampai hari ini; sesi
// hari ini ikut hanya bila absensinya sudah tercatat.
export const getAssistantSantriMonthAttendance = async (db, ctx, { santriId, month }) => {
  const scope = await assistantScope(ctx);
  requireAssistantRole(scope);
  if (scope.blind || !UUID.test(String(santriId || ''))) return null;

  const today = jakartaToday();
  const base = typeof month === 'string' && /^\d{4}-\d{2}/.test(month) ? month.slice(0, 7) : today.slice(0, 7);
  const monthStart = `${base}-01`;
  const monthEnd = addDays(`${addDays(monthStart, 32).slice(0, 7)}-01`, -1);
  const end = monthEnd < today ? monthEnd : today;

  const classes = classFilterParam(scope);
  const row = await db.prepare(`
    select s."id", s."tanggal_pendaftaran", cm."start_date"
      from "santri" s
      join "class_memberships" cm on cm."santri_id" = s."id" and cm."status" = 'active'
     where s."id" = ? and s."deleted_at" is null
       and (? is null or cm."class_id" in (select "value" from json_each(?)))
     limit 1`).bind(santriId, classes, classes).first();
  if (!row) return null;

  const [taps, corrections, holidays] = await Promise.all([
    db.prepare(`select "user_id", "attendance_date", "status", "check_in_time" from "attendance"
                 where "user_id" = ? and "attendance_date" between ? and ?`).bind(santriId, monthStart, end).all(),
    db.prepare(`select "santri_id", "tanggal" from "attendance_presence_corrections"
                 where "santri_id" = ? and "tanggal" between ? and ?`).bind(santriId, monthStart, end).all(),
    loadHolidays(db),
  ]);
  const tapsByDay = groupTaps(taps.results);
  const corrected = new Set((corrections.results || []).map((c) => c.tanggal));
  const from = maxDate(monthStart, row.start_date || row.tanggal_pendaftaran || monthStart);

  const sesi = schoolDaysBetween(from, end, scope.settings.school_days, holidays.set)
    .map((d) => {
      const tapsToday = tapsByDay.get(`${santriId}|${d}`);
      return { t: d, s: sessionStatus(tapsToday, corrected.has(d)), tercatat: Boolean(tapsToday?.length) };
    })
    // Sesi hari ini belum tentu sudah berlangsung: ikut hanya bila absensinya sudah ada.
    .filter((x) => x.t < today || x.tercatat)
    .map(({ t, s }) => ({ t, s }));

  return {
    bulan: monthStart,
    sampai: end,
    sesi,
    total: sesi.length,
    hadir: sesi.filter((x) => x.s !== 'absen').length,
  };
};

// Usia dalam tahun penuh pada tanggal tertentu, setara extract(year from age(...)).
export const ageOn = (birth, on) => {
  if (!birth || !/^\d{4}-\d{2}-\d{2}/.test(birth)) return null;
  const [by, bm, bd] = birth.slice(0, 10).split('-').map(Number);
  const [y, m, d] = on.split('-').map(Number);
  return y - by - ((m < bm || (m === bm && d < bd)) ? 1 : 0);
};

// Ulang tahun pada tahun tertentu; 29 Februari jatuh ke 28 Februari di tahun bukan kabisat.
const birthdayInYear = (birth, year) => {
  const [, month, day] = birth.slice(0, 10).split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
};

export const nextBirthday = (birth, today) => {
  if (!birth || !/^\d{4}-\d{2}-\d{2}/.test(birth)) return null;
  const year = Number(today.slice(0, 4));
  const thisYear = birthdayInYear(birth, year);
  return thisYear >= today ? thisYear : birthdayInYear(birth, year + 1);
};

const PROFILE_SQL = (key) => `
select s."id" as santri_id, s."nama_lengkap", s."nama_panggilan", s."jenis_kelamin", s."tanggal_lahir", s."jilid", s."points",
  (select json_group_array(json_object('dari', h."from_jilid", 'ke', h."to_jilid",
            'hari_lalu', cast(julianday(?) - julianday(date(h."changed_at", '+7 hours')) as integer)))
     from (select * from "jilid_history" where "santri_id" = s."id" order by "changed_at" desc limit 6) h) as riwayat_jilid,
  (select json_group_array(json_object('kategori', p."category", 'materi', p."item_name", 'skor', p."score",
            'hari_sejak_dinilai', cast(julianday(?) - julianday(date(p."updated_at", '+7 hours')) as integer)))
     from (select hp.*, i."item_order" from (select * from "hafalan_progress" where "santri_id" = s."id"
                                              order by "updated_at" desc limit 200) hp
             left join "hafalan_items" i on i."id" = hp."item_id"
            order by hp."category", i."item_order" is null, i."item_order", hp."item_name") p) as hafalan,
  (select json_group_array(json_object('kategori', w."category", 'materi', w."item_name", 'skor', w."score", 'status', w."status"))
     from (select hi."category", hi."item_name", hp."score", coalesce(hp."status", 'belum') as status
             from "hafalan_items" hi
             left join "hafalan_progress" hp on hp."item_id" = hi."id" and hp."santri_id" = s."id"
            where hi."is_active" = 1 and hi."program_scope" = 'TPQ' and trim(hi."jilid") = ${key}
            order by hi."category", hi."item_order" is null, hi."item_order", hi."item_name") w) as hafalan_wajib_jilid,
  (select json_group_array(json_object('indikator', k."item_name", 'skor', k."score"))
     from (select ci."item_name", cs."score" from "santri_character_scores" cs
             join "character_assessment_items" ci on ci."id" = cs."item_id"
            where cs."santri_id" = s."id" order by ci."item_order") k) as karakter,
  (select json_group_array(st."strength_key") from "santri_character_strengths" st where st."santri_id" = s."id") as kekuatan,
  (select json_group_array(json_object('tingkat', b."level", 'perilaku', substr(b."behavior", 1, 200),
            'tindak_lanjut', substr(b."follow_up", 1, 200), 'hari_lalu', cast(julianday(?) - julianday(b."incident_date") as integer)))
     from (select * from "santri_behavior_records" where "santri_id" = s."id" and "incident_date" >= ?
            order by "incident_date" desc limit 10) b) as perilaku,
  (select json_group_array(json_object('catatan', substr(n."note", 1, 300),
            'hari_lalu', cast(julianday(?) - julianday(date(n."created_at", '+7 hours')) as integer)))
     from (select * from "santri_notes" where "santri_id" = s."id" and (? = 1 or "visibility" = 'internal')
            order by "created_at" desc limit 8) n) as catatan_guru
  from "santri" s
 where s."id" = ? and s."deleted_at" is null`;

export const loadProfile = async (db, scope, santriId) => {
  const today = jakartaToday();
  const row = await db.prepare(PROFILE_SQL(hafalanJilidKeySql('s."jilid"')))
    .bind(today, today, today, addDays(today, -180), today, scope.admin ? 1 : 0, santriId).first();
  if (!row) return null;
  const birthday = nextBirthday(row.tanggal_lahir, today);
  return {
    santri_id: row.santri_id,
    nama_lengkap: row.nama_lengkap,
    nama_panggilan: row.nama_panggilan,
    jenis_kelamin: row.jenis_kelamin,
    usia: ageOn(row.tanggal_lahir, today),
    ultah_berikut: birthday,
    usia_ultah_berikut: birthday ? Number(birthday.slice(0, 4)) - Number(row.tanggal_lahir.slice(0, 4)) : null,
    jilid: row.jilid,
    poin: Math.round((Number(row.points) || 0) * 10) / 10,
    riwayat_jilid: parseJson(row.riwayat_jilid, []),
    hafalan: parseJson(row.hafalan, []),
    hafalan_wajib_jilid: parseJson(row.hafalan_wajib_jilid, []),
    karakter: parseJson(row.karakter, []),
    kekuatan: parseJson(row.kekuatan, []),
    perilaku: parseJson(row.perilaku, []),
    catatan_guru: parseJson(row.catatan_guru, []),
  };
};

// Guru boleh atas santri yang keanggotaan aktifnya ada di salah satu kelas yang ia ampu.
export const requireSantriInScope = async (db, scope, santriId) => {
  if (scope.admin) return;
  if (!UUID.test(String(santriId || ''))) throw new RpcError('CLASS_ACCESS_DENIED', 403);
  const row = await db.prepare(`
    select 1 as ok from "class_memberships"
     where "santri_id" = ? and "status" = 'active' and "class_id" in (select "value" from json_each(?)) limit 1`)
    .bind(santriId, classFilterParam(scope)).first();
  if (!row) throw new RpcError('CLASS_ACCESS_DENIED', 403);
};

export const getAssistantSantriProfile = async (db, ctx, { santriId }) => {
  const scope = await assistantScope(ctx);
  await requireSantriInScope(db, scope, santriId);
  if (scope.blind) return null;
  return loadProfile(db, scope, santriId);
};

export const getAssistantAiClasses = async (db, ctx) => {
  const scope = await assistantScope(ctx);
  if (scope.blind) return [];
  const classes = classFilterParam(scope);
  const { results } = await db.prepare(`
    select c."id", c."nama_kelas" from "classes" c
     where c."deleted_at" is null
       and (? is null or c."id" in (select "value" from json_each(?)))
       and exists (select 1 from "class_memberships" cm join "santri" s on s."id" = cm."santri_id"
                    where cm."class_id" = c."id" and cm."status" = 'active' and s."deleted_at" is null and s."kategori" = 'Anak')
     order by c."nama_kelas"`).bind(classes, classes).all();
  return results || [];
};

// Ringkasan per santri satu kelas (TPQ anak). Nama dikembalikan hanya untuk penyamaran di
// server; yang dikirim ke penyedia AI adalah kode S1, S2, dan seterusnya.
export const loadClassRoster = async (db, classId) => {
  const today = jakartaToday();
  const { results } = await db.prepare(`
    select s."id" as santri_id, s."nama_lengkap", s."nama_panggilan", s."jenis_kelamin", s."tanggal_lahir", s."points",
      (select round(avg(cs."score"), 1) from "santri_character_scores" cs where cs."santri_id" = s."id") as karakter_rata,
      (select json_group_array(st."strength_key") from "santri_character_strengths" st where st."santri_id" = s."id") as kekuatan,
      (select count(*) from "santri_behavior_records" b
        where b."santri_id" = s."id" and b."incident_date" >= ?) as perilaku_90_hari
      from "class_memberships" cm
      join "santri" s on s."id" = cm."santri_id"
     where cm."class_id" = ? and cm."status" = 'active' and s."deleted_at" is null and s."kategori" = 'Anak'
     order by s."nama_lengkap"`).bind(addDays(today, -90), classId).all();
  return (results || []).map((r) => ({
    santri_id: r.santri_id,
    nama_lengkap: r.nama_lengkap,
    nama_panggilan: r.nama_panggilan,
    jenis_kelamin: r.jenis_kelamin,
    usia: ageOn(r.tanggal_lahir, today),
    poin: Math.round((Number(r.points) || 0) * 10) / 10,
    karakter_rata: r.karakter_rata === null ? null : Number(r.karakter_rata),
    kekuatan: parseJson(r.kekuatan, []),
    perilaku_90_hari: Number(r.perilaku_90_hari) || 0,
  }));
};

export const getAssistantClassRoster = async (db, ctx, { classId }) => {
  const scope = await assistantScope(ctx);
  if (!canSeeClass(scope, classId)) throw new RpcError('CLASS_ACCESS_DENIED', 403);
  if (scope.blind) return [];
  return loadClassRoster(db, classId);
};
