// Pengaturan asisten: nilai bawaan, penggabungan, dan validasi.
//
// Terjemahan assistant_default_settings, jsonb_deep_merge, get_assistant_settings, dan
// save_assistant_settings dari LPQ Al-Fath Maulana. Pengaturan disimpan berversi: setiap simpanan
// menjadi baris baru di assistant_settings, dan yang berlaku adalah bawaan ditimpa baris terakhir.
//
// Mode senyap aktif secara bawaan, sama seperti asalnya: aturan tetap berjalan dan menyimpan
// peringatan, tetapi guru belum melihat apa pun sampai admin mematikannya.

import { RpcError } from '../rpc/santri.js';
import { currentUserRole } from '../auth/predicates.js';

export const DEFAULT_KONTEKS = `LPQ Al-Muhajirun adalah lembaga pendidikan Al-Qur'an (TPQ) yang memakai metode Qiroati. Asisten ini membantu guru TPQ anak (kategori Anak) yang mengaji Senin–Jumat.

Metode Qiroati:
- Santri belajar membaca Al-Qur'an langsung dengan tartil sesuai kaidah tajwid, tanpa mengeja.
- Urutan tingkat di lembaga ini: Pra TK A, B, C; Jilid 1A–1C, 2A–2B, 3A–3B, 4A–4B, 5A–5B, Jilid Juz 27, Jilid 6; lalu Al-Qur'an, Ghorib Tajwid, dan Finishing.
- Santri naik jilid hanya bila bacaannya sudah lancar dan benar pada jilid saat ini dan lulus tes kenaikan oleh pentashih. Santri tidak dipaksa naik bila belum siap; yang dicari adalah penyebab tertahan dan latihan yang tepat.
- Prinsip santri: Lancar, Cepat, Tepat, Benar (LCTB). Prinsip guru: Teliti, Waspada, Tegas (TIWAGAS).

Penilaian di aplikasi:
- Hafalan pendamping (Doa harian, bacaan Sholat, Surat pendek, Tahfizh) dinilai skor 1–4; skor 4 berarti sudah hafal/aman, skor 1–3 masih perlu dilatih.
- Karakter dinilai skor 1–4 per indikator: 1 Belum Berkembang, 2 Mulai Berkembang, 3 Berkembang Sesuai Harapan, 4 Sangat Berkembang. Guru juga memilih kekuatan karakter santri.
- Catatan perilaku bertingkat Ringan, Sedang, Berat, masing-masing dengan tindak lanjut (nasihat; pembinaan dan kabar ke orang tua; pertemuan dengan orang tua dan keputusan kepala LPQ).
- Poin gamifikasi diperoleh santri dari kehadiran dan kegiatan; cocok dipakai untuk apresiasi, bukan hukuman.
- Kehadiran dicatat otomatis lewat kartu RFID; guru hanya mengoreksi bila santri sebenarnya hadir.

Gaya saran yang diharapkan: lembut dan beradab, menguatkan anak dan orang tua, memakai apresiasi sebelum koreksi, dan selalu bisa dilakukan guru di sesi mengaji atau bersama wali.`;

export const AI_PROVIDER_IDS = ['mock', 'anthropic', 'openai', 'gemini', 'deepseek', 'opencode', 'openrouter', 'groq', 'custom'];

export const defaultSettings = () => ({
  version: 1,
  silent_mode: true,
  school_days: [1, 2, 3, 4, 5],
  attendance: {
    consecutive_sessions: 3,
    repeat_every_sessions: 3,
    high_consecutive_sessions: 6,
    monthly_min_percent: 75,
  },
  jilid: {
    default_days: 30,
    per_jilid: {},
    repeat_every_days: 14,
  },
  hafalan: {
    proses_max_days: 30,
    required_items_after_percent: 50,
    murojaah_review_max_days: 7,
  },
  // Disimpan agar bentuk pengaturannya sama dengan asalnya. Bot Telegram belum dibawa ke sini,
  // jadi bagian ini tidak dipakai apa pun selain validasi.
  notifications: {
    telegram_enabled: false,
    bot_username: '',
    summary_hour: 19,
    dashboard_url: 'https://lpqalmuhajirun.id/dashboard',
  },
  ai: {
    enabled: false,
    provider: 'mock',
    model: '',
    base_url: '',
    monthly_budget_usd: 10,
    price_input_per_mtok: 0,
    price_output_per_mtok: 0,
    daily_limit_per_user: 40,
    weekly_digest: false,
    konteks_lembaga: DEFAULT_KONTEKS,
  },
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Nilai tersimpan menimpa bawaan per kunci, sehingga kunci baru di versi berikutnya tetap punya
// nilai. per_jilid diganti utuh, tidak digabung, supaya jilid yang dihapus admin benar-benar hilang.
export const deepMerge = (base, patch) => {
  if (patch === undefined || patch === null) return base;
  if (!isObject(base) || !isObject(patch)) return patch;
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = key === 'per_jilid' || !(key in base) ? value : deepMerge(base[key], value);
  }
  return result;
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

// Pengaturan yang berlaku beserta id baris terakhir (null bila belum pernah disimpan).
export const loadSettings = async (db) => {
  const row = await db.prepare('select "id", "settings" from "assistant_settings" order by "id" desc limit 1').first();
  return {
    id: row?.id ?? null,
    settings: deepMerge(defaultSettings(), row ? parseJson(row.settings) : {}),
  };
};

// Pengaturan dibaca sekali per permintaan; beberapa RPC dalam satu panggilan AI memakainya.
export const settingsFor = async (ctx) => {
  if (!ctx.assistantSettings) ctx.assistantSettings = await loadSettings(ctx.db);
  return ctx.assistantSettings;
};

const isInt = (value) => typeof value === 'number' && Number.isInteger(value);
const intBetween = (value, min, max) => isInt(value) && value >= min && value <= max;
const numberBetween = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

const invalid = (detail) => new RpcError(`INVALID_SETTINGS: ${detail}`, 400);

// Nilai di luar batas ditolak, bukan dipotong. Batas-batasnya sama dengan versi Postgres.
export const validateSettings = (v) => {
  if (typeof v.silent_mode !== 'boolean') throw invalid('silent_mode');

  if (!Array.isArray(v.school_days) || v.school_days.length === 0
    || v.school_days.some((d) => !intBetween(d, 1, 7))) throw invalid('school_days');

  const a = v.attendance || {};
  const j = v.jilid || {};
  const h = v.hafalan || {};
  const n = v.notifications || {};
  if (!(
    intBetween(a.consecutive_sessions, 2, 20)
    && intBetween(a.repeat_every_sessions, 1, 20)
    && intBetween(a.high_consecutive_sessions, a.consecutive_sessions, 40)
    && intBetween(a.monthly_min_percent, 1, 100)
    && intBetween(j.default_days, 7, 730)
    && intBetween(j.repeat_every_days, 1, 90)
    && intBetween(h.proses_max_days, 3, 365)
    && intBetween(h.required_items_after_percent, 10, 100)
    && intBetween(h.murojaah_review_max_days, 1, 60)
    && intBetween(n.summary_hour, 6, 20)
  )) throw invalid('angka di luar batas');

  if (typeof n.telegram_enabled !== 'boolean'
    || !/^([A-Za-z][A-Za-z0-9_]{3,31})?$/.test(String(n.bot_username ?? ''))
    || !/^https:\/\/\S{4,200}$/.test(String(n.dashboard_url ?? ''))) throw invalid('notifications');

  const ai = v.ai || {};
  if (typeof ai.enabled !== 'boolean'
    || !AI_PROVIDER_IDS.includes(ai.provider)
    || !/^[A-Za-z0-9._:/@-]{0,100}$/.test(String(ai.model ?? ''))
    || !/^(https:\/\/\S{4,200})?$/.test(String(ai.base_url ?? ''))
    || (ai.provider === 'custom' && !ai.base_url)
    || !numberBetween(ai.monthly_budget_usd, 0, 1000)
    || !numberBetween(ai.price_input_per_mtok, 0, 1000)
    || !numberBetween(ai.price_output_per_mtok, 0, 1000)
    || !intBetween(ai.daily_limit_per_user, 1, 500)
    || typeof ai.konteks_lembaga !== 'string'
    || ai.konteks_lembaga.length > 6000
    || typeof ai.weekly_digest !== 'boolean') throw invalid('ai');

  if (!isObject(j.per_jilid)) throw invalid('per_jilid');
  for (const [key, value] of Object.entries(j.per_jilid)) {
    if (key.length > 40 || !intBetween(value, 7, 730)) throw invalid(`per_jilid ${key}`);
  }
};

export const requireAdmin = async (ctx) => {
  if (!ctx.userId) throw new RpcError('AUTH_REQUIRED', 401);
  if ((await currentUserRole(ctx)) !== 'admin') throw new RpcError('ADMIN_REQUIRED', 403);
};

export const getAssistantSettings = async (db, ctx) => {
  if (!ctx.userId) throw new RpcError('AUTH_REQUIRED', 401);
  // Postgres membuka fungsi ini untuk semua pengguna login; panel guru membutuhkannya untuk tahu
  // mode senyap dan apakah AI aktif. Isinya tidak memuat kunci apa pun.
  return (await settingsFor(ctx)).settings;
};

export const saveAssistantSettings = async (db, ctx, { settings }) => {
  await requireAdmin(ctx);
  if (!isObject(settings)) throw new RpcError('INVALID_SETTINGS', 400);
  // Digabung dengan pengaturan TERSIMPAN terakhir, bukan bawaan, agar perubahan sebagian tidak
  // mengembalikan kunci lain ke nilai bawaan.
  const merged = deepMerge((await loadSettings(db)).settings, settings);
  validateSettings(merged);
  await db.prepare('insert into "assistant_settings" ("settings", "created_by") values (?, ?)')
    .bind(JSON.stringify(merged), ctx.userId).run();
  ctx.assistantSettings = null;
  return merged;
};
