// Tanggal untuk asisten. Semuanya string YYYY-MM-DD dalam WIB, sama seperti kolom
// attendance_date dan academic_calendar.date, sehingga bisa dibandingkan langsung sebagai teks.
//
// Perhitungannya memakai UTC tengah hari pada tanggal itu sendiri, bukan jam setempat mesin,
// supaya hasilnya tidak bergeser di Worker (UTC) maupun di laptop (WIB).

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const jakartaToday = (now = Date.now()) => new Date(now + WIB_OFFSET_MS).toISOString().slice(0, 10);

const toUtcNoon = (date) => Date.parse(`${date}T12:00:00Z`);
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

export const isValidDate = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && fromUtc(toUtcNoon(value)) === value;

export const addDays = (date, days) => fromUtc(toUtcNoon(date) + days * DAY_MS);

export const daysBetween = (from, to) => Math.round((toUtcNoon(to) - toUtcNoon(from)) / DAY_MS);

export const maxDate = (...dates) => dates.filter(Boolean).sort().at(-1) ?? null;

// Senin = 1 ... Minggu = 7, seperti extract(isodow) di Postgres.
export const isoWeekday = (date) => {
  const day = new Date(toUtcNoon(date)).getUTCDay();
  return day === 0 ? 7 : day;
};

// Label pekan ISO, setara to_char(d, 'IYYY-"W"IW').
export const isoWeekLabel = (date) => {
  const thursday = new Date(toUtcNoon(date) + (4 - isoWeekday(date)) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const dayOfYear = Math.round((thursday.getTime() - Date.UTC(year, 0, 1, 12)) / DAY_MS);
  return `${year}-W${String(1 + Math.floor(dayOfYear / 7)).padStart(2, '0')}`;
};

// DD-MM-YYYY untuk kalimat peringatan.
export const formatDmy = (date) => (date ? date.split('-').reverse().join('-') : '');

// Hari sekolah dari..sampai, inklusif, urut lama ke baru: hari yang ada di schoolDays dan bukan
// libur kalender akademik.
export const schoolDaysBetween = (from, to, schoolDays, holidays) => {
  const result = [];
  if (!from || !to || from > to) return result;
  const allowed = new Set((schoolDays || []).map(Number));
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (allowed.has(isoWeekday(d)) && !holidays.has(d)) result.push(d);
  }
  return result;
};

// Hari libur kalender di antara (setelah from, sampai to). Dipakai menghitung lama di jilid,
// seperti versi Postgres yang mengurangkan libur dari selisih hari.
export const countHolidaysAfter = (from, to, holidayList) => {
  let count = 0;
  for (const day of holidayList) if (day > from && day <= to) count += 1;
  return count;
};

// SQL untuk "tanggal ini hari sekolah". Parameter pertama adalah array JSON hari ISO
// (1..7). strftime('%w') memakai Minggu = 0, jadi dipetakan ke 7.
export const schoolDaySql = (column) => `(
  (case cast(strftime('%w', ${column}) as integer) when 0 then 7 else cast(strftime('%w', ${column}) as integer) end)
    in (select cast("value" as integer) from json_each(?))
  and not exists (select 1 from "academic_calendar" ac where ac."date" = ${column} and ac."is_holiday" = 1)
)`;

// Kunci jilid hafalan TPQ ('1'..'6') dari jilid santri ('Jilid 2A' -> '2'). Setara regex
// '^Jilid\s*([1-6])[A-C]?$' versi Postgres, ditulis dengan GLOB karena SQLite tidak punya regex.
export const hafalanJilidKeySql = (column) => `(case
  when trim(${column}) glob 'Jilid [1-6]' or trim(${column}) glob 'Jilid [1-6][A-C]'
    then substr(trim(${column}), 7, 1)
  when trim(${column}) glob 'Jilid[1-6]' or trim(${column}) glob 'Jilid[1-6][A-C]'
    then substr(trim(${column}), 6, 1)
  else null end)`;

export const hafalanJilidKey = (jilid) => {
  const match = /^Jilid ?([1-6])[A-C]?$/.exec(String(jilid ?? '').trim());
  return match ? match[1] : null;
};
