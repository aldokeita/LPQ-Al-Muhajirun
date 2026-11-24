// Asisten AI: terjemahan Edge Function assistant-ai dari LPQ Al-Fath Maulana ke Worker.
//
// recommend (guru/admin)    : saran untuk satu santri di panel "Perlu Perhatian".
// class_insight (guru/admin): saran menyeluruh satu kelas. only_cached=true hanya membaca simpanan.
// chat (guru/admin)         : konsultasi guru tentang kelas/santri; riwayat tersimpan per pengguna.
// report (guru/admin)       : draf rapor bulanan untuk wali satu santri.
// card_note (guru/admin)    : pesan atau caption kartu santri.
// status, test (admin)      : status kunci & pemakaian, uji koneksi.
//
// Data dibaca dengan hak pengguna (mode senyap berlaku). Nama santri disamarkan menjadi kode
// S1, S2, ... sebelum dikirim ke penyedia AI, dan dikembalikan menjadi nama hanya di jawaban.
// Ringkasan pekanan lewat Telegram tidak ikut dibawa.

import { RpcError } from '../../rpc/santri.js';
import { currentUserRole } from '../../auth/predicates.js';
import { assistantScope, canSeeClass, parseJson, UUID } from '../access.js';
import { jakartaToday } from '../dates.js';
import { loadAttentionItems } from '../attention.js';
import { getAssistantSantriProfile, loadClassRoster, loadSnapshots } from '../santri-data.js';
import {
  buildUserPrompt, estimateCost, inputHash, parseRecommendation, RESULT_SCHEMA, sha256Hex, SYSTEM_PROMPT,
} from './prompt.js';
import {
  buildChatContext, buildChatMessages, buildClassContext, buildNameMasker, buildProfileContext, buildRecommendationInput,
  CARD_CAPTION_SYSTEM_PROMPT, CARD_NOTE_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, CLASS_PROMPT_VERSION, CLASS_RESULT_SCHEMA,
  CLASS_SYSTEM_PROMPT, parseCardCaption, parseCardNote, parseClassInsight, parseReport, REPORT_PROMPT_VERSION,
  REPORT_SCHEMA, REPORT_SYSTEM_PROMPT, selectKnowledge, withKnowledge,
} from './context.js';
import { AiProviderError, generate, keyStatus, resolveProvider } from './providers.js';

export const ERROR_STATUS = {
  AI_KEY_MISSING: 503, AI_MODEL_MISSING: 503, AI_BASE_URL_MISSING: 503,
  AI_KEY_REJECTED: 502, AI_RATE_LIMITED: 429, AI_PROVIDER_ERROR: 502, AI_REFUSED: 422,
  AI_INVALID_JSON: 502, AI_EMPTY_RESPONSE: 502, AI_DAILY_LIMIT: 429, AI_BUDGET_EXCEEDED: 429,
  NOT_FOUND: 404, INVALID_REQUEST: 400,
};

export const errorCode = (err) => (err instanceof AiProviderError ? err.code
  : String(err?.message || '').startsWith('AI_') ? String(err.message) : 'AI_PROVIDER_ERROR');

export const friendlyMessage = (code) => (
  code === 'AI_DAILY_LIMIT' ? 'Batas permintaan AI harian Anda sudah tercapai. Coba lagi besok.'
    : code === 'AI_BUDGET_EXCEEDED' ? 'Anggaran AI bulan ini sudah habis. Hubungi admin.'
      : ['AI_KEY_MISSING', 'AI_MODEL_MISSING', 'AI_BASE_URL_MISSING', 'AI_KEY_REJECTED'].includes(code)
        ? 'Asisten AI belum siap dipakai. Hubungi admin untuk memeriksa pengaturan AI.'
        : code === 'AI_RATE_LIMITED'
          ? 'Penyedia AI sedang sibuk. Coba lagi beberapa menit lagi.'
          : 'Asisten AI gagal menjawab. Coba lagi sebentar lagi.');

// Galat dengan kode mesin (dibaca frontend) dan pesan yang boleh ditampilkan apa adanya.
export const aiError = (code, message, status = ERROR_STATUS[code] || 400) => {
  const error = new RpcError(message || friendlyMessage(code), status);
  error.code = code;
  return error;
};

const nowIso = () => new Date().toISOString();

// Awal bulan berjalan menurut WIB, dalam UTC ISO, sebanding dengan created_at.
const monthStartIso = () => new Date(`${jakartaToday().slice(0, 7)}-01T00:00:00+07:00`).toISOString();

export const monthUsage = async (db) => {
  const row = await db.prepare(`
    select coalesce(sum("biaya_usd"), 0) as biaya_usd,
      sum(case when "status" in ('ok', 'uji') then 1 else 0 end) as permintaan,
      sum(case when "status" = 'cache' then 1 else 0 end) as dari_cache,
      sum(case when "status" = 'gagal' then 1 else 0 end) as gagal,
      coalesce(sum("input_tokens"), 0) as input_tokens,
      coalesce(sum("output_tokens"), 0) as output_tokens
      from "assistant_ai_usage" where "created_at" >= ?`).bind(monthStartIso()).first();
  return {
    bulan: jakartaToday().slice(0, 7),
    biaya_usd: Number(row?.biaya_usd) || 0,
    permintaan: Number(row?.permintaan) || 0,
    dari_cache: Number(row?.dari_cache) || 0,
    gagal: Number(row?.gagal) || 0,
    input_tokens: Number(row?.input_tokens) || 0,
    output_tokens: Number(row?.output_tokens) || 0,
  };
};

// Batas harian per pengguna dan anggaran bulanan lembaga, dalam satu query.
const usageLimit = async (db, ai, userId) => {
  const row = await db.prepare(`
    select (select count(*) from "assistant_ai_usage"
             where "user_id" = ? and "status" = 'ok' and "created_at" >= ?) as hari_ini,
           (select coalesce(sum("biaya_usd"), 0) from "assistant_ai_usage" where "created_at" >= ?) as biaya`)
    .bind(userId, new Date(Date.now() - 24 * 3600 * 1000).toISOString(), monthStartIso()).first();
  if ((Number(row?.hari_ini) || 0) >= Number(ai.daily_limit_per_user || 40)) return 'AI_DAILY_LIMIT';
  if ((Number(row?.biaya) || 0) >= Number(ai.monthly_budget_usd ?? 10)) return 'AI_BUDGET_EXCEEDED';
  return null;
};

const loadKnowledge = async (db) => {
  const { results } = await db.prepare(`
    select "judul", "kategori", "isi" from "assistant_ai_knowledge"
     where "aktif" = 1 order by "updated_at" desc limit 60`).all();
  return results || [];
};

const requireSantriId = (value) => {
  const id = String(value || '');
  if (!UUID.test(id)) throw aiError('INVALID_REQUEST', 'Santri tidak valid.');
  return id;
};

// Satu permintaan assistant_ai. env dipakai untuk kunci penyedia; fetchImpl/loadAnthropic untuk tes.
export const assistantAi = async (db, ctx, body, env = {}, deps = {}) => {
  if (!ctx.userId) throw aiError('AUTH_REQUIRED', 'Sesi tidak valid. Silakan masuk ulang.', 401);
  const action = String(body?.action || 'recommend');
  const scope = await assistantScope(ctx);
  const ai = scope.settings.ai || {};
  const konteks = String(ai.konteks_lembaga || '');
  const getEnv = (name) => env?.[name];
  const provider = resolveProvider(ai, getEnv);
  const callProvider = (prompt) => generate(provider, prompt, deps);

  const logUsage = (row) => db.prepare(`
    insert into "assistant_ai_usage"
      ("id", "user_id", "santri_id", "fitur", "provider", "model", "status", "input_tokens", "output_tokens", "biaya_usd", "galat")
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), ctx.userId, row.santri_id ?? null, row.fitur, provider.id, provider.model || '',
      row.status, row.input_tokens || 0, row.output_tokens || 0, row.biaya_usd || 0, row.galat ?? null)
    .run();

  // ===== Admin: status & uji =====
  if (action === 'status' || action === 'test') {
    if ((await currentUserRole(ctx)) !== 'admin') throw aiError('ADMIN_REQUIRED', 'Hanya admin.', 403);
    if (action === 'status') {
      return {
        providers: keyStatus(getEnv),
        active: { id: provider.id, label: provider.label, model: provider.model, hasKey: provider.hasKey, price: provider.price },
        usage: await monthUsage(db),
      };
    }
    try {
      const started = Date.now();
      const result = await callProvider({
        system: 'Balas hanya dengan JSON {"ringkasan": "...", "langkah": [{"judul": "...", "alasan": "..."}], "pesan_wali": "..."}.',
        user: 'Uji koneksi. Isi ringkasan dengan kata OK.',
        schema: RESULT_SCHEMA,
      });
      await logUsage({
        fitur: 'uji', status: 'uji', input_tokens: result.inputTokens, output_tokens: result.outputTokens,
        biaya_usd: estimateCost(result, provider.price),
      });
      return { ok: true, ms: Date.now() - started, model: provider.model, sample: result.text.slice(0, 200) };
    } catch (err) {
      const code = errorCode(err);
      throw aiError(code, String(err?.message || err).slice(0, 300), ERROR_STATUS[code] || 502);
    }
  }

  if (!['recommend', 'class_insight', 'chat', 'report', 'card_note'].includes(action)) {
    throw aiError('INVALID_REQUEST', 'Aksi tidak dikenal.');
  }
  if (!ai.enabled) throw aiError('AI_DISABLED', 'Asisten AI belum diaktifkan admin.', 403);

  const knowledge = await loadKnowledge(db);

  const checkLimits = async () => {
    const code = await usageLimit(db, ai, ctx.userId);
    if (code) throw aiError(code, friendlyMessage(code), 429);
  };

  // Panggil AI dan catat pemakaian; galat dicatat lalu dilempar dengan pesan yang ramah.
  const callAi = async (fitur, santriId, prompt, parse) => {
    let tokens = { inputTokens: 0, outputTokens: 0 };
    try {
      const result = await callProvider(prompt);
      tokens = result;
      const parsed = parse(result.text);
      await logUsage({
        fitur, santri_id: santriId, status: 'ok', input_tokens: tokens.inputTokens, output_tokens: tokens.outputTokens,
        biaya_usd: estimateCost(tokens, provider.price),
      });
      return parsed;
    } catch (err) {
      const code = errorCode(err);
      await logUsage({
        fitur, santri_id: santriId, status: 'gagal', input_tokens: tokens.inputTokens, output_tokens: tokens.outputTokens,
        biaya_usd: estimateCost(tokens, provider.price), galat: `${code}: ${String(err?.message || err)}`.slice(0, 300),
      });
      throw aiError(code, friendlyMessage(code), ERROR_STATUS[code] || 502);
    }
  };

  const readSnapshot = async (santriId) => (await loadSnapshots(db, scope, [santriId]))
    .find((s) => s.santri_id === santriId) || null;

  // Profil santri; galat akses diterjemahkan seperti versi asalnya.
  const readProfile = async (santriId) => {
    try {
      return await getAssistantSantriProfile(db, ctx, { santriId });
    } catch (err) {
      if (err instanceof RpcError) throw aiError('CLASS_ACCESS_DENIED', 'Anda tidak memiliki akses ke santri ini.', 403);
      throw err;
    }
  };

  const readClass = async (classId) => {
    if (!canSeeClass(scope, classId)) throw aiError('CLASS_ACCESS_DENIED', 'Anda tidak memiliki akses ke kelas ini.', 403);
    const roster = scope.blind ? [] : await loadClassRoster(db, classId);
    if (roster.length === 0) throw aiError('CLASS_EMPTY', 'Belum ada santri TPQ anak di kelas ini.', 404);
    const ids = roster.map((r) => r.santri_id);
    const idSet = new Set(ids);
    const snapshots = await loadSnapshots(db, scope, ids);
    const items = (await loadAttentionItems(db, scope, classId)).filter((i) => idSet.has(i.santri_id));
    const masker = buildNameMasker(roster);
    return { roster, snapshots, items, masker, kelas: buildClassContext(roster, snapshots, items, masker) };
  };

  // ===== Saran per santri =====
  if (action === 'recommend') {
    const santriId = requireSantriId(body?.santri_id);
    const items = scope.blind ? [] : (await loadAttentionItems(db, scope, null)).filter((i) => i.santri_id === santriId);
    if (items.length === 0) throw aiError('NO_ALERTS', 'Santri ini tidak sedang perlu perhatian.', 404);

    const snapshot = await readSnapshot(santriId);
    const profile = await readProfile(santriId);
    const masker = buildNameMasker(profile ? [profile] : []);
    const input = buildRecommendationInput(items, snapshot, profile, masker);
    const pustaka = selectKnowledge(knowledge, `${snapshot?.jilid || ''} ${items.map((i) => i.rule).join(' ')} hafalan jilid kehadiran`);
    const hash = await inputHash({ input, konteks, pustaka }, provider.id, provider.model);

    if (body?.refresh !== true) {
      const cached = await db.prepare(`
        select "id", "hasil", "provider", "model", "created_at" from "assistant_ai_recommendations"
         where "santri_id" = ? and "input_hash" = ? order by "created_at" desc limit 1`).bind(santriId, hash).first();
      if (cached) {
        await logUsage({ fitur: 'rekomendasi', santri_id: santriId, status: 'cache' });
        return { ...cached, hasil: parseJson(cached.hasil, {}), cached: true };
      }
    }
    await checkLimits();

    // Profil memakai kode S1; prompt saran memakai placeholder {nama}.
    const userPrompt = buildUserPrompt(input).replace(/\bS1\b/g, '{nama}');
    const hasil = await callAi('rekomendasi', santriId,
      { system: withKnowledge(konteks, pustaka, SYSTEM_PROMPT), user: userPrompt, schema: RESULT_SCHEMA }, parseRecommendation);

    const saved = { id: crypto.randomUUID(), hasil, provider: provider.id, model: provider.model, created_at: nowIso() };
    await db.prepare(`
      insert into "assistant_ai_recommendations"
        ("id", "santri_id", "requested_by", "alert_ids", "input_hash", "provider", "model", "hasil", "created_at")
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(saved.id, santriId, ctx.userId, JSON.stringify(items.map((i) => i.alert_id)), hash, provider.id,
        provider.model, JSON.stringify(hasil), saved.created_at)
      .run();
    return { ...saved, cached: false };
  }

  // ===== Rapor wali =====
  if (action === 'report') {
    const santriId = requireSantriId(body?.santri_id);
    const profile = await readProfile(santriId);
    if (!profile) throw aiError('NOT_FOUND', 'Data santri tidak tersedia.', 404);
    const snapshot = await readSnapshot(santriId);
    const masker = buildNameMasker([profile]);
    const { perkara: _p, santri: _s, ...data } = buildRecommendationInput([], snapshot, profile, masker);
    const bulan = jakartaToday().slice(0, 7);
    const input = { bulan, ...data };
    const pustaka = selectKnowledge(knowledge, `${profile.jilid || ''} rapor wali orang tua rumah`);
    const hash = await sha256Hex(JSON.stringify({ v: REPORT_PROMPT_VERSION, p: provider.id, m: provider.model, konteks, pustaka, input }));

    if (body?.refresh !== true) {
      const cached = await db.prepare(`
        select "id", "hasil", "provider", "model", "created_at", "bulan" from "assistant_ai_reports"
         where "santri_id" = ? and "input_hash" = ? order by "created_at" desc limit 1`).bind(santriId, hash).first();
      if (cached) {
        await logUsage({ fitur: 'rapor', santri_id: santriId, status: 'cache' });
        return { ...cached, hasil: parseJson(cached.hasil, {}), cached: true };
      }
    }
    await checkLimits();
    const hasil = await callAi('rapor', santriId, {
      kind: 'rapor',
      system: withKnowledge(konteks, pustaka, REPORT_SYSTEM_PROMPT),
      user: `Data santri bulan ${bulan} (JSON):\n${JSON.stringify(input).replace(/\bS1\b/g, '{nama}')}\n\nSusun rapor sesuai aturan.`,
      schema: REPORT_SCHEMA,
    }, parseReport);
    const saved = { id: crypto.randomUUID(), hasil, provider: provider.id, model: provider.model, created_at: nowIso(), bulan };
    await db.prepare(`
      insert into "assistant_ai_reports"
        ("id", "santri_id", "bulan", "requested_by", "input_hash", "provider", "model", "hasil", "created_at")
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(saved.id, santriId, bulan, ctx.userId, hash, provider.id, provider.model, JSON.stringify(hasil), saved.created_at)
      .run();
    return { ...saved, cached: false };
  }

  // ===== Pesan kartu santri =====
  if (action === 'card_note') {
    const santriId = requireSantriId(body?.santri_id);
    const jenis = body?.jenis === 'jilid' ? 'jilid' : 'profil';
    const caption = body?.bagian === 'caption';
    const profile = await readProfile(santriId);
    if (!profile) throw aiError('NOT_FOUND', 'Data santri tidak tersedia.', 404);
    await checkLimits();
    const snapshot = await readSnapshot(santriId);
    const masker = buildNameMasker([profile]);
    const { perkara: _p, santri: _s, ...data } = buildRecommendationInput([], snapshot, profile, masker);
    const kenaikan = (profile.riwayat_jilid || [])[0] || null;
    const input = { jenis_kartu: jenis, jilid_sekarang: profile.jilid || null, kenaikan_terakhir: kenaikan, ...data };
    const parsed = await callAi(caption ? 'caption' : 'kartu', santriId, {
      system: withKnowledge(konteks, '', caption ? CARD_CAPTION_SYSTEM_PROMPT : CARD_NOTE_SYSTEM_PROMPT),
      messages: [{
        role: 'user',
        content: `Data santri (JSON):\n${JSON.stringify(input).replace(/\bS1\b/g, '{nama}')}\n\n${caption ? `Tulis caption untuk kartu "${jenis}".` : `Tulis pesan kartu "${jenis}".`}`,
      }],
      json: false,
    }, caption ? parseCardCaption : parseCardNote);
    return caption
      ? { caption: parsed, provider: provider.id, model: provider.model }
      : { pesan: parsed, provider: provider.id, model: provider.model };
  }

  // ===== Saran kelas =====
  if (action === 'class_insight') {
    const classId = String(body?.class_id || '');
    if (!UUID.test(classId)) throw aiError('INVALID_REQUEST', 'Kelas tidak valid.');
    const cls = await readClass(classId);
    const names = (kodeMap) => Object.fromEntries(Object.entries(kodeMap || {})
      .map(([code, id]) => [code, cls.masker.display[cls.masker.codeOf(id) || ''] || code]));

    const hash = await sha256Hex(JSON.stringify({ v: CLASS_PROMPT_VERSION, p: provider.id, m: provider.model, konteks, kelas: cls.kelas }));
    const cached = await db.prepare(`
      select "id", "hasil", "provider", "model", "created_at", "kode_santri", "input_hash" from "assistant_ai_class_insights"
       where "class_id" = ? order by "created_at" desc limit 1`).bind(classId).first();

    if (body?.only_cached === true || (cached && cached.input_hash === hash && body?.refresh !== true)) {
      if (!cached) return { hasil: null };
      if (body?.only_cached !== true) await logUsage({ fitur: 'kelas', status: 'cache' });
      const { input_hash: _h, kode_santri: kodeText, ...rest } = cached;
      return {
        ...rest, hasil: parseJson(rest.hasil, {}), nama: names(parseJson(kodeText, {})), usang: cached.input_hash !== hash, cached: true,
      };
    }

    await checkLimits();
    const jilids = [...new Set(cls.kelas.santri.map((s) => s.jilid).filter(Boolean))].join(' ');
    const pustaka = selectKnowledge(knowledge, `kelas ${jilids} hafalan kehadiran motivasi`);
    const hasil = await callAi('kelas', null, {
      kind: 'kelas',
      system: withKnowledge(konteks, pustaka, CLASS_SYSTEM_PROMPT),
      user: `Gambaran kelas (JSON):\n${JSON.stringify(cls.kelas)}\n\nBuat saran sesuai aturan.`,
      schema: CLASS_RESULT_SCHEMA,
    }, (text) => parseClassInsight(text, cls.kelas.santri.map((s) => s.kode)));
    const kodeSantri = cls.masker.santriOf;
    const saved = { id: crypto.randomUUID(), hasil, provider: provider.id, model: provider.model, created_at: nowIso() };
    await db.prepare(`
      insert into "assistant_ai_class_insights"
        ("id", "class_id", "requested_by", "input_hash", "provider", "model", "hasil", "kode_santri", "created_at")
      values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(saved.id, classId, ctx.userId, hash, provider.id, provider.model, JSON.stringify(hasil),
        JSON.stringify(kodeSantri), saved.created_at)
      .run();
    return { ...saved, nama: names(kodeSantri), usang: false, cached: false };
  }

  // ===== Chat =====
  const message = String(body?.message || '').trim();
  if (!message || message.length > 2000) throw aiError('INVALID_REQUEST', 'Tulis pertanyaan (maksimal 2.000 karakter).');
  const classId = String(body?.class_id || '');
  if (!UUID.test(classId)) throw aiError('INVALID_REQUEST', 'Pilih kelas dulu.');
  const santriId = body?.santri_id ? String(body.santri_id) : null;
  if (santriId && !UUID.test(santriId)) throw aiError('INVALID_REQUEST', 'Santri tidak valid.');
  const conversationIdIn = body?.conversation_id ? String(body.conversation_id) : null;
  if (conversationIdIn && !UUID.test(conversationIdIn)) throw aiError('INVALID_REQUEST', 'Percakapan tidak valid.');

  const cls = await readClass(classId);
  if (santriId && !cls.roster.some((r) => r.santri_id === santriId)) {
    throw aiError('INVALID_REQUEST', 'Santri bukan anggota kelas ini.');
  }
  const profile = santriId ? await readProfile(santriId) : null;

  let history = [];
  if (conversationIdIn) {
    const conv = await db.prepare('select "user_id" from "assistant_ai_conversations" where "id" = ?').bind(conversationIdIn).first();
    if (!conv || conv.user_id !== ctx.userId) throw aiError('NOT_FOUND', 'Percakapan tidak ditemukan.', 404);
    const { results } = await db.prepare(`
      select "role", "content" from "assistant_ai_messages" where "conversation_id" = ? order by "created_at" asc`)
      .bind(conversationIdIn).all();
    history = results || [];
  }
  await checkLimits();

  const masker = cls.masker;
  const profil = santriId ? buildProfileContext(profile, masker) : null;
  const pustaka = selectKnowledge(knowledge, `${message} ${profile?.jilid || ''}`);
  const contextText = buildChatContext({ kelas: cls.kelas, profil, kodeFokus: santriId ? masker.codeOf(santriId) : null });
  const messages = buildChatMessages(history, message, contextText, masker);
  const answer = await callAi('chat', santriId, {
    system: withKnowledge(konteks, pustaka, CHAT_SYSTEM_PROMPT), messages, json: false,
  }, (text) => {
    if (!String(text || '').trim()) throw new Error('AI_EMPTY_RESPONSE');
    return masker.unmask(String(text).trim()).slice(0, 6000);
  });

  const now = Date.now();
  const conversationId = conversationIdIn || crypto.randomUUID();
  const userMessageId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const statements = [
    conversationIdIn
      ? db.prepare('update "assistant_ai_conversations" set "updated_at" = ?, "santri_id" = ?, "class_id" = ? where "id" = ?')
        .bind(new Date(now).toISOString(), santriId, classId, conversationId)
      : db.prepare(`
          insert into "assistant_ai_conversations" ("id", "user_id", "class_id", "santri_id", "judul", "sumber")
          values (?, ?, ?, ?, ?, 'dasbor')`).bind(conversationId, ctx.userId, classId, santriId, message.slice(0, 80)),
    db.prepare('insert into "assistant_ai_messages" ("id", "conversation_id", "role", "content", "created_at") values (?, ?, ?, ?, ?)')
      .bind(userMessageId, conversationId, 'user', message, new Date(now).toISOString()),
    db.prepare('insert into "assistant_ai_messages" ("id", "conversation_id", "role", "content", "created_at") values (?, ?, ?, ?, ?)')
      .bind(messageId, conversationId, 'assistant', answer, new Date(now + 1).toISOString()),
  ];
  await db.batch(statements);
  return {
    conversation_id: conversationId, answer, provider: provider.id, model: provider.model,
    user_message_id: userMessageId, message_id: messageId,
  };
};
