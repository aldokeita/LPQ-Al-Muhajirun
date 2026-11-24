// Adapter asisten "Perlu Perhatian" dan asisten AI.
//
// Dibawa dari LPQ Al-Fath Maulana. Di sana sebagian data dibaca langsung dari tabel lewat RLS dan
// AI dipanggil lewat Edge Function; di sini semuanya lewat RPC Worker (/api/rpc/...), dengan nama
// dan bentuk hasil yang sama supaya komponen tidak perlu tahu bedanya.

import { rpc as callRpc } from '@/lib/dataClient';

const ERROR_MESSAGES = {
  ADMIN_REQUIRED: 'Hanya admin yang bisa melakukan ini.',
  CLASS_ACCESS_DENIED: 'Anda tidak memiliki akses ke kelas ini.',
  ALERT_NOT_FOUND: 'Peringatan tidak ditemukan atau bukan untuk kelas Anda.',
  DATE_NOT_IN_ALERT: 'Tanggal yang dipilih tidak termasuk dalam peringatan ini.',
  INVALID_DATES: 'Pilih minimal satu tanggal.',
  REASON_REQUIRED: 'Tulis alasan mengabaikan peringatan.',
  INVALID_CONTACT_DATE: 'Tanggal kontak tidak valid.',
  INVALID_SETTINGS: 'Ada pengaturan di luar batas yang diizinkan.',
  FUTURE_DATE_NOT_ALLOWED: 'Tanggal tidak boleh di masa depan.',
  AUTH_REQUIRED: 'Sesi login berakhir. Silakan masuk kembali.',
  INVALID_RANGE: 'Rentang tanggal tidak valid (maksimal 400 hari).',
};

export const getAssistantErrorMessage = (error) => {
  const message = String(error?.message || '');
  const code = Object.keys(ERROR_MESSAGES).find((key) => message.includes(key) || error?.code === key);
  if (code) return ERROR_MESSAGES[code];
  if (error?.status === 403) return 'Akses ditolak.';
  return message || 'Terjadi kesalahan. Coba lagi.';
};

const rpc = async (name, params = {}) => {
  const { data, error } = await callRpc(name, params);
  if (error) throw error;
  return data;
};

export const fetchAttention = (classId = null) => rpc('get_assistant_attention', { p_class_id: classId });

export const recordPresenceCorrections = ({ alertId, dates, keterangan }) => rpc('record_presence_corrections', {
  p_alert_id: alertId, p_dates: dates, p_keterangan: keterangan || null,
});

export const decideAlert = ({ alertId, keputusan, catatan }) => rpc('decide_assistant_alert', {
  p_alert_id: alertId, p_keputusan: keputusan, p_catatan: catatan || null,
});

// Satu kontak wali untuk satu atau beberapa perkara santri yang sama; tercatat sebagai satu kontak.
export const recordAlertFollowup = ({ alertIds, form }) => rpc('record_alert_wali_followup', {
  p_alert_ids: alertIds,
  p_tanggal_kontak: form.tanggal_kontak,
  p_saluran: form.saluran,
  p_hasil: form.hasil,
  p_catatan: form.catatan?.trim() || null,
});

export const fetchAssistantSettings = () => rpc('get_assistant_settings');

export const saveAssistantSettings = (patch) => rpc('save_assistant_settings', { p_settings: patch });

// Manual oleh admin: memeriksa sampai kemarin, termasuk aturan pekanan (dedupe per pekan mencegah ganda).
export const runAssistantRulesNow = () => rpc('run_assistant_rules', { p_ref: null, p_weekly: true });

// Server menerima paling banyak 200 santri per panggilan (batas waktu CPU Worker gratis), jadi
// panel admin yang memuat seluruh lembaga dipecah per 100 dan diminta bersamaan.
const SNAPSHOT_CHUNK = 100;

export const fetchSantriSnapshots = async (santriIds = []) => {
  const ids = [...new Set(santriIds.filter(Boolean))];
  if (!ids.length) return [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += SNAPSHOT_CHUNK) chunks.push(ids.slice(i, i + SNAPSHOT_CHUNK));
  const results = await Promise.all(chunks.map((chunk) => rpc('get_assistant_santri_snapshot', { p_santri_ids: chunk })));
  return results.flatMap((data) => (Array.isArray(data) ? data : []));
};

// ===== Asisten AI =====

const invokeAssistantAi = async (body) => {
  const { data, error } = await callRpc('assistant_ai', body);
  if (error) {
    const err = new Error(error.message || 'Asisten AI tidak dapat dihubungi.');
    err.code = error.code && error.code !== 'rpc_error' ? error.code : 'AI_UNAVAILABLE';
    throw err;
  }
  return data;
};

export const requestAiRecommendation = (santriId, { refresh = false } = {}) =>
  invokeAssistantAi({ action: 'recommend', santri_id: santriId, refresh });

export const fetchAiStatus = () => invokeAssistantAi({ action: 'status' });
export const testAiConnection = () => invokeAssistantAi({ action: 'test' });

// Saran terakhir per santri (admin semua, guru hanya santri kelasnya).
export const fetchLatestAiRecommendations = async (santriIds = []) => {
  if (!santriIds.length) return {};
  return (await rpc('get_latest_ai_recommendations', { p_santri_ids: santriIds })) || {};
};

export const requestClassInsight = (classId, { refresh = false, onlyCached = false } = {}) =>
  invokeAssistantAi({ action: 'class_insight', class_id: classId, refresh, only_cached: onlyCached });

export const sendAiChat = ({ conversationId, classId, santriId, message }) => invokeAssistantAi({
  action: 'chat', conversation_id: conversationId || null, class_id: classId, santri_id: santriId || null, message,
});

export const fetchAiClasses = async () => {
  const data = await rpc('get_assistant_ai_classes');
  return Array.isArray(data) ? data : [];
};

export const fetchAiClassRoster = async (classId) => {
  const data = await rpc('get_assistant_class_roster', { p_class_id: classId });
  return (Array.isArray(data) ? data : []).map((r) => ({ id: r.santri_id, nama: r.nama_lengkap, panggilan: r.nama_panggilan }));
};

export const fetchAiConversations = async () => (await rpc('list_ai_conversations')) || [];

export const fetchAiMessages = async (conversationId) =>
  (await rpc('get_ai_messages', { p_conversation_id: conversationId })) || [];

export const deleteAiConversation = async (conversationId) => {
  await rpc('delete_ai_conversation', { p_conversation_id: conversationId });
};

// ===== Rapor wali =====
export const requestAiReport = (santriId, { refresh = false } = {}) =>
  invokeAssistantAi({ action: 'report', santri_id: santriId, refresh });

export const fetchLatestAiReport = (santriId) => rpc('get_latest_ai_report', { p_santri_id: santriId });

// ===== Umpan balik 👍/👎 =====
export const fetchMyAiFeedback = async (jenis, targetIds = []) => {
  const ids = targetIds.filter(Boolean);
  if (!ids.length) return {};
  return (await rpc('get_my_ai_feedback', { p_jenis: jenis, p_target_ids: ids })) || {};
};

// userId tidak dikirim: server selalu memakai pengguna yang sedang login.
export const saveAiFeedback = ({ jenis, targetId, nilai, komentar = null }) => rpc('save_ai_feedback', {
  p_jenis: jenis, p_target_id: targetId, p_nilai: nilai || 0, p_komentar: komentar ? String(komentar).trim().slice(0, 500) : null,
});

// ===== Pustaka materi (admin) =====
export const fetchAiKnowledge = async () => (await rpc('list_ai_knowledge')) || [];

export const saveAiKnowledge = ({ id, patch }) => rpc('save_ai_knowledge', { p_id: id || null, p_patch: patch });

export const deleteAiKnowledge = async (id) => {
  await rpc('delete_ai_knowledge', { p_id: id });
};

// ===== Evaluasi (admin) =====
export const fetchAiEvaluation = (from, to) => rpc('get_assistant_ai_evaluation', { p_from: from, p_to: to });

// ===== Profil santri untuk kartu & rapor =====
export const fetchSantriProfile = (santriId) => rpc('get_assistant_santri_profile', { p_santri_id: santriId });

export const fetchSantriMonthAttendance = (santriId, month = null) => rpc('get_assistant_santri_month_attendance', { p_santri_id: santriId, p_month: month });

export const requestCardNote = (santriId, jenis) => invokeAssistantAi({ action: 'card_note', santri_id: santriId, jenis });
export const requestCardCaption = (santriId, jenis) => invokeAssistantAi({ action: 'card_note', santri_id: santriId, jenis, bagian: 'caption' });
