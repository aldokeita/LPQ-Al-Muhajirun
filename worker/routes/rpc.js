// Endpoint RPC bisnis.
//
// Nama rutenya sengaja sama dengan nama function lama, supaya pemetaan dari kode frontend
// yang memanggil supabase.rpc('nama') bisa ditelusuri satu lawan satu.

import { createAuthContext } from '../auth/predicates.js';
import { RpcError, changeSantriJilid, getSantriLeaderboard, incrementSantriPoints } from '../rpc/santri.js';
import {
  changeSantriCategory, getGuruTransferClassOptions, moveSantriToClass, removeSantriFromClass, transferSantriToClassByGuru,
} from '../rpc/class-transfer.js';
import { readSessionCookie, verifySession } from '../auth/session.js';
import { getAssistantSettings, saveAssistantSettings } from '../assistant/settings.js';
import { runAssistantRules } from '../assistant/rules.js';
import {
  decideAssistantAlert, getAssistantAttention, recordAlertWaliFollowup, recordPresenceCorrections,
} from '../assistant/attention.js';
import {
  getAssistantAiClasses, getAssistantClassRoster, getAssistantSantriMonthAttendance, getAssistantSantriProfile,
  getAssistantSantriSnapshot,
} from '../assistant/santri-data.js';
import { assistantAi } from '../assistant/ai/actions.js';
import {
  deleteAiConversation, deleteAiKnowledge, getAiMessages, getAssistantAiEvaluation, getAssistantAiUsage,
  getLatestAiRecommendations, getLatestAiReport, getMyAiFeedback, listAiConversations, listAiKnowledge, saveAiFeedback,
  saveAiKnowledge,
} from '../assistant/ai/data.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const HANDLERS = {
  remove_santri_from_class: (db, ctx, body) =>
    removeSantriFromClass(db, ctx, { santriId: body?.p_santri_id, reason: body?.p_reason }),
  get_santri_leaderboard: (db, ctx, body) =>
    getSantriLeaderboard(db, ctx, { page: body?.p_page, pageSize: body?.p_page_size, scope: body?.p_scope }),
  increment_santri_points: (db, ctx, body) =>
    incrementSantriPoints(db, ctx, { santriId: body?.p_santri_id, amount: body?.p_amount }),
  change_santri_jilid: (db, ctx, body) =>
    changeSantriJilid(db, ctx, { santriId: body?.p_santri_id, toJilid: body?.p_to_jilid }),
  change_santri_category: (db, ctx, body) =>
    changeSantriCategory(db, ctx, {
      santriId: body?.p_santri_id, targetCategory: body?.p_target_category, reason: body?.p_reason,
    }),
  move_santri_to_class: (db, ctx, body) =>
    moveSantriToClass(db, ctx, { santriId: body?.p_santri_id, toClassId: body?.p_to_class_id, reason: body?.p_reason }),
  transfer_santri_to_class_by_guru: (db, ctx, body) =>
    transferSantriToClassByGuru(db, ctx, {
      santriId: body?.p_santri_id, toClassId: body?.p_to_class_id, reason: body?.p_reason,
    }),
  get_guru_transfer_class_options: (db, ctx, body) =>
    getGuruTransferClassOptions(db, ctx, { santriId: body?.p_santri_id }),

  // ===== Asisten: Perlu Perhatian, pengaturan, data santri =====
  get_assistant_settings: (db, ctx) => getAssistantSettings(db, ctx),
  save_assistant_settings: (db, ctx, body) => saveAssistantSettings(db, ctx, { settings: body?.p_settings }),
  run_assistant_rules: (db, ctx, body) =>
    runAssistantRules(db, { ctx, ref: body?.p_ref ?? null, weekly: body?.p_weekly ?? null }),
  get_assistant_attention: (db, ctx, body) => getAssistantAttention(db, ctx, { classId: body?.p_class_id ?? null }),
  decide_assistant_alert: (db, ctx, body) =>
    decideAssistantAlert(db, ctx, { alertId: body?.p_alert_id, keputusan: body?.p_keputusan, catatan: body?.p_catatan }),
  record_presence_corrections: (db, ctx, body) =>
    recordPresenceCorrections(db, ctx, { alertId: body?.p_alert_id, dates: body?.p_dates, keterangan: body?.p_keterangan }),
  record_alert_wali_followup: (db, ctx, body) => recordAlertWaliFollowup(db, ctx, {
    alertIds: body?.p_alert_ids, tanggalKontak: body?.p_tanggal_kontak, saluran: body?.p_saluran,
    hasil: body?.p_hasil, catatan: body?.p_catatan,
  }),
  get_assistant_santri_snapshot: (db, ctx, body) => getAssistantSantriSnapshot(db, ctx, { santriIds: body?.p_santri_ids }),
  get_assistant_santri_profile: (db, ctx, body) => getAssistantSantriProfile(db, ctx, { santriId: body?.p_santri_id }),
  get_assistant_santri_month_attendance: (db, ctx, body) =>
    getAssistantSantriMonthAttendance(db, ctx, { santriId: body?.p_santri_id, month: body?.p_month ?? null }),
  get_assistant_ai_classes: (db, ctx) => getAssistantAiClasses(db, ctx),
  get_assistant_class_roster: (db, ctx, body) => getAssistantClassRoster(db, ctx, { classId: body?.p_class_id }),

  // ===== Asisten AI =====
  assistant_ai: (db, ctx, body, env) => assistantAi(db, ctx, body, env),
  get_latest_ai_recommendations: (db, ctx, body) => getLatestAiRecommendations(db, ctx, { santriIds: body?.p_santri_ids }),
  get_latest_ai_report: (db, ctx, body) => getLatestAiReport(db, ctx, { santriId: body?.p_santri_id }),
  list_ai_conversations: (db, ctx) => listAiConversations(db, ctx),
  get_ai_messages: (db, ctx, body) => getAiMessages(db, ctx, { conversationId: body?.p_conversation_id }),
  delete_ai_conversation: (db, ctx, body) => deleteAiConversation(db, ctx, { conversationId: body?.p_conversation_id }),
  get_my_ai_feedback: (db, ctx, body) => getMyAiFeedback(db, ctx, { jenis: body?.p_jenis, targetIds: body?.p_target_ids }),
  save_ai_feedback: (db, ctx, body) => saveAiFeedback(db, ctx, {
    jenis: body?.p_jenis, targetId: body?.p_target_id, nilai: body?.p_nilai, komentar: body?.p_komentar,
  }),
  list_ai_knowledge: (db, ctx) => listAiKnowledge(db, ctx),
  save_ai_knowledge: (db, ctx, body) => saveAiKnowledge(db, ctx, { id: body?.p_id ?? null, patch: body?.p_patch }),
  delete_ai_knowledge: (db, ctx, body) => deleteAiKnowledge(db, ctx, { id: body?.p_id }),
  get_assistant_ai_usage: (db, ctx) => getAssistantAiUsage(db, ctx),
  get_assistant_ai_evaluation: (db, ctx, body) => getAssistantAiEvaluation(db, ctx, { from: body?.p_from, to: body?.p_to }),
};

export const handleRpc = async (request, env, url) => {
  const name = url.pathname.replace('/api/rpc/', '');
  const handler = HANDLERS[name];
  if (!handler) return null;
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_body', message: 'Body harus berupa JSON.' }, 400);
  }

  const payload = await verifySession(env.SESSION_SECRET, readSessionCookie(request));
  const ctx = createAuthContext(env.DB, payload?.sub ?? null);

  try {
    return json({ data: await handler(env.DB, ctx, body, env) });
  } catch (error) {
    // Pesan RpcError memang ditujukan untuk pengguna dan ditampilkan apa adanya,
    // persis seperti pesan exception dari RPC lama.
    if (error instanceof RpcError) {
      // code (bila ada) dipakai asisten AI agar frontend bisa membedakan jenis galat.
      return json({ error: 'rpc_error', message: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    }
    console.error(`[rpc] ${name} gagal:`, error.message);
    return json({ error: 'rpc_failed', message: 'Permintaan tidak dapat diproses.' }, 500);
  }
};
