// Menguji asisten (Perlu Perhatian, AI, leaderboard kelas) terhadap salinan data produksi.
//
// Yang diuji: hak akses per peran, mode senyap, keputusan/koreksi/kontak wali, semua aksi AI
// dengan penyedia tiruan, bentuk permintaan ke Claude, dan batas 50 query D1 per pemanggilan.
//
// Pemakaian:
//   node --experimental-sqlite scripts/test-assistant.mjs <0001.sql> <data.sql> <0003.sql>

import { createD1 } from './lib/d1-shim.mjs';
import { createAuthContext } from '../worker/auth/predicates.js';
import { getSantriLeaderboard } from '../worker/rpc/santri.js';
import { runAssistantRules } from '../worker/assistant/rules.js';
import { getAssistantSettings, saveAssistantSettings } from '../worker/assistant/settings.js';
import {
  decideAssistantAlert, getAssistantAttention, recordAlertWaliFollowup, recordPresenceCorrections,
} from '../worker/assistant/attention.js';
import {
  getAssistantAiClasses, getAssistantClassRoster, getAssistantSantriMonthAttendance, getAssistantSantriProfile,
  getAssistantSantriSnapshot,
} from '../worker/assistant/santri-data.js';
import { assistantAi } from '../worker/assistant/ai/actions.js';
import {
  deleteAiConversation, deleteAiKnowledge, getAiMessages, getAssistantAiEvaluation, getLatestAiRecommendations,
  getLatestAiReport, getMyAiFeedback, listAiConversations, listAiKnowledge, saveAiFeedback, saveAiKnowledge,
} from '../worker/assistant/ai/data.js';
import { jakartaToday } from '../worker/assistant/dates.js';

const files = process.argv.slice(2);
if (files.length < 3) {
  console.error('Pemakaian: node --experimental-sqlite scripts/test-assistant.mjs <0001.sql> <data.sql> <0003.sql>');
  process.exit(1);
}
const { db, sqlite, stats } = createD1(files);

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) passed += 1; else failed += 1;
  console.log(`  ${ok ? 'OK   ' : 'GAGAL'} ${label}${ok || !detail ? '' : ` (${detail})`}`);
};
const MAX_QUERIES = 50;
// Setiap pemanggilan memakai ctx baru, seperti satu permintaan HTTP ke Worker.
const call = async (label, fn) => {
  stats.queries = 0;
  const result = await fn();
  check(`${label}: ${stats.queries} query (batas ${MAX_QUERIES})`, stats.queries <= MAX_QUERIES);
  return result;
};
const expectError = async (label, promise, code) => {
  try {
    await promise;
    check(label, false, 'tidak melempar');
  } catch (error) {
    const got = error.code || error.message;
    check(label, String(got).includes(code), `dapat ${got}`);
  }
};
const as = (userId) => createAuthContext(db, userId);

const admin = sqlite.prepare(`select "id" from "user_profiles" where "role" = 'admin' and "status" = 'active' limit 1`).get().id;
// Guru yang mengampu kelas dengan santri anak terbanyak, dan guru lain sebagai pembanding.
const gurus = sqlite.prepare(`
  select c."id_guru" as guru, c."id" as class_id, count(*) as n from "classes" c
    join "class_memberships" cm on cm."class_id" = c."id" and cm."status" = 'active'
    join "santri" s on s."id" = cm."santri_id" and s."deleted_at" is null and s."kategori" = 'Anak'
    join "user_profiles" u on u."id" = c."id_guru" and u."role" = 'guru' and u."status" = 'active'
   where c."deleted_at" is null group by c."id" order by n desc`).all();
const guru = gurus[0];
const otherGuru = gurus.find((g) => g.guru !== guru.guru);
const guruClasses = new Set(gurus.filter((g) => g.guru === guru.guru).map((g) => g.class_id));
console.log(`Guru uji mengampu ${guruClasses.size} kelas; kelas utama ${guru.n} santri anak.`);

console.log('\nAturan & mode senyap');
const rules = await call('aturan (cron, tanpa ctx)', () => runAssistantRules(db, { ref: '2026-09-18', weekly: true }));
check('aturan membuat peringatan', rules.peringatan_baru > 0, JSON.stringify(rules));
await expectError('guru tidak boleh menjalankan aturan', runAssistantRules(db, { ctx: as(guru.guru) }), 'ADMIN_REQUIRED');
const blind = await call('perhatian guru saat senyap', () => getAssistantAttention(db, as(guru.guru)));
check('guru tidak melihat apa pun saat senyap', blind.items.length === 0 && blind.mode_senyap === true);
check('guru tidak mendapat kelas AI saat senyap', (await getAssistantAiClasses(db, as(guru.guru))).length === 0);
const adminView = await call('perhatian admin', () => getAssistantAttention(db, as(admin)));
check('peringatan saat senyap tersimpan senyap, hanya terhitung untuk admin',
  adminView.items.length === 0 && adminView.senyap_tersimpan > 0, JSON.stringify({ n: adminView.items.length, s: adminView.senyap_tersimpan }));

await expectError('guru tidak boleh menyimpan pengaturan',
  saveAssistantSettings(db, as(guru.guru), { settings: { silent_mode: false } }), 'ADMIN_REQUIRED');
await expectError('pengaturan di luar batas ditolak',
  saveAssistantSettings(db, as(admin), { settings: { attendance: { consecutive_sessions: 99 } } }), 'INVALID_SETTINGS');
await call('simpan pengaturan', () => saveAssistantSettings(db, as(admin), {
  settings: { silent_mode: false, ai: { enabled: true, provider: 'mock' } },
}));
const saved = await getAssistantSettings(db, as(guru.guru));
check('pengaturan tersimpan dan sisanya tetap bawaan',
  saved.silent_mode === false && saved.ai.enabled && saved.attendance.consecutive_sessions === 3);
const loud = await call('aturan setelah senyap dimatikan', () => runAssistantRules(db, { ref: '2026-09-18', weekly: true }));
check('aturan membuat peringatan yang tampil', loud.peringatan_baru > 0 && loud.senyap === false, JSON.stringify(loud));
const adminLoud = await getAssistantAttention(db, as(admin));
check('admin melihat peringatan semua kelas', adminLoud.items.length > 0);

console.log('\nPerlu Perhatian (guru)');
const view = await call('perhatian guru', () => getAssistantAttention(db, as(guru.guru)));
check('guru melihat peringatan kelasnya', view.items.length > 0);
check('semua peringatan guru dari kelas yang ia ampu', view.items.every((i) => guruClasses.has(i.class_id)));
await expectError('guru tidak boleh membuka kelas lain',
  getAssistantAttention(db, as(guru.guru), { classId: otherGuru.class_id }), 'CLASS_ACCESS_DENIED');
const foreignAlert = adminLoud.items.find((i) => !guruClasses.has(i.class_id));
if (foreignAlert) {
  await expectError('guru tidak boleh memutuskan peringatan kelas lain',
    decideAssistantAlert(db, as(guru.guru), { alertId: foreignAlert.alert_id, keputusan: 'ditangani' }), 'ALERT_NOT_FOUND');
}
const [firstItem] = view.items;
await expectError('abaikan tanpa alasan ditolak',
  decideAssistantAlert(db, as(guru.guru), { alertId: firstItem.alert_id, keputusan: 'diabaikan' }), 'REASON_REQUIRED');
const absen = view.items.find((i) => i.rule === 'absen_beruntun');
if (absen) {
  await expectError('tanggal di luar peringatan ditolak',
    recordPresenceCorrections(db, as(guru.guru), { alertId: absen.alert_id, dates: ['2020-01-01'] }), 'DATE_NOT_IN_ALERT');
  const dates = absen.detail.absent_dates.slice().sort().reverse().slice(0, 1);
  const fix = await call('koreksi hadir', () => recordPresenceCorrections(db, as(guru.guru), { alertId: absen.alert_id, dates }));
  check('koreksi tanggal terakhir menutup peringatan absen', fix.koreksi_baru === 1 && fix.ditutup === true, JSON.stringify(fix));
}
const followItem = view.items.find((i) => i.alert_id !== absen?.alert_id);
await call('kontak wali', () => recordAlertWaliFollowup(db, as(guru.guru), {
  alertIds: [followItem.alert_id], tanggalKontak: jakartaToday(), saluran: 'whatsapp', hasil: 'terhubung',
}));
await expectError('tanggal kontak masa depan ditolak', recordAlertWaliFollowup(db, as(guru.guru), {
  alertIds: [followItem.alert_id], tanggalKontak: '2099-01-01', saluran: 'whatsapp', hasil: 'terhubung',
}), 'INVALID_CONTACT_DATE');

console.log('\nData santri');
const roster = await call('daftar kelas', () => getAssistantClassRoster(db, as(guru.guru), { classId: guru.class_id }));
check('daftar kelas berisi santri anak', roster.length === guru.n);
const snaps = await call('snapshot satu kelas', () => getAssistantSantriSnapshot(db, as(guru.guru), { santriIds: roster.map((r) => r.santri_id) }));
check('snapshot untuk setiap santri', snaps.length === roster.length);
const target = roster[0].santri_id;
const profile = await call('profil santri', () => getAssistantSantriProfile(db, as(guru.guru), { santriId: target }));
check('profil terbaca', profile?.santri_id === target);
const outsider = sqlite.prepare(`select cm."santri_id" as id from "class_memberships" cm
  where cm."status" = 'active' and cm."class_id" = ?`).get(otherGuru.class_id)?.id;
await expectError('guru tidak boleh membuka profil santri kelas lain',
  getAssistantSantriProfile(db, as(guru.guru), { santriId: outsider }), 'CLASS_ACCESS_DENIED');
const month = await call('kehadiran bulanan', () => getAssistantSantriMonthAttendance(db, as(guru.guru), { santriId: target, month: '2026-09' }));
check('kehadiran bulanan punya angka', month && typeof month === 'object');

console.log('\nAsisten AI (penyedia tiruan)');
const recTarget = view.items.find((i) => i.santri_id)?.santri_id;
const rec = await call('saran santri', () => assistantAi(db, as(guru.guru), { action: 'recommend', santri_id: recTarget }));
check('saran berisi langkah', Array.isArray(rec.hasil?.langkah) && rec.cached === false);
const recAgain = await call('saran santri (cache)', () => assistantAi(db, as(guru.guru), { action: 'recommend', santri_id: recTarget }));
check('permintaan kedua dari cache', recAgain.cached === true && recAgain.id === rec.id);
const latest = await getLatestAiRecommendations(db, as(guru.guru), { santriIds: [recTarget, outsider] });
check('saran terakhir hanya untuk santri kelasnya', Boolean(latest[recTarget]) && !latest[outsider]);
await expectError('saran untuk santri kelas lain ditolak',
  assistantAi(db, as(guru.guru), { action: 'recommend', santri_id: outsider }), 'NO_ALERTS');

const insight = await call('saran kelas', () => assistantAi(db, as(guru.guru), { action: 'class_insight', class_id: guru.class_id }));
check('saran kelas tersimpan dengan nama', Boolean(insight.hasil?.ringkasan) && insight.cached === false && typeof insight.nama === 'object');
const insightCached = await assistantAi(db, as(guru.guru), { action: 'class_insight', class_id: guru.class_id, only_cached: true });
check('saran kelas dibaca dari simpanan', insightCached.cached === true && insightCached.usang === false);
await expectError('saran kelas lain ditolak',
  assistantAi(db, as(guru.guru), { action: 'class_insight', class_id: otherGuru.class_id }), 'CLASS_ACCESS_DENIED');

const chat1 = await call('chat baru', () => assistantAi(db, as(guru.guru), {
  action: 'chat', class_id: guru.class_id, santri_id: target, message: `Bagaimana membantu ${roster[0].nama_lengkap}?`,
}));
check('chat menjawab dan membuat percakapan', Boolean(chat1.answer) && Boolean(chat1.conversation_id));
const chat2 = await call('chat lanjutan', () => assistantAi(db, as(guru.guru), {
  action: 'chat', class_id: guru.class_id, conversation_id: chat1.conversation_id, message: 'Lalu apa lagi?',
}));
check('chat lanjutan memakai percakapan yang sama', chat2.conversation_id === chat1.conversation_id);
const messages = await getAiMessages(db, as(guru.guru), { conversationId: chat1.conversation_id });
check('empat pesan tersimpan berurutan', messages.length === 4 && messages[0].role === 'user' && messages[3].role === 'assistant');
check('percakapan tampil di riwayat', (await listAiConversations(db, as(guru.guru))).some((c) => c.id === chat1.conversation_id));
await expectError('guru lain tidak bisa membaca percakapan',
  getAiMessages(db, as(otherGuru.guru), { conversationId: chat1.conversation_id }), 'NOT_FOUND');
await expectError('guru lain tidak bisa melanjutkan percakapan', assistantAi(db, as(otherGuru.guru), {
  action: 'chat', class_id: otherGuru.class_id, conversation_id: chat1.conversation_id, message: 'Halo',
}), 'NOT_FOUND');
await deleteAiConversation(db, as(guru.guru), { conversationId: chat1.conversation_id });
check('percakapan terhapus beserta pesannya',
  sqlite.prepare('select count(*) n from "assistant_ai_messages" where "conversation_id" = ?').get(chat1.conversation_id).n === 0);

const report = await call('rapor wali', () => assistantAi(db, as(guru.guru), { action: 'report', santri_id: target }));
check('rapor berisi bagian pembuka', Boolean(report.hasil?.pembuka) && report.bulan === jakartaToday().slice(0, 7));
check('rapor terakhir terbaca', (await getLatestAiReport(db, as(guru.guru), { santriId: target }))?.id === report.id);
await expectError('rapor santri kelas lain ditolak',
  assistantAi(db, as(guru.guru), { action: 'report', santri_id: outsider }), 'CLASS_ACCESS_DENIED');
const note = await call('pesan kartu', () => assistantAi(db, as(guru.guru), { action: 'card_note', santri_id: target, jenis: 'jilid' }));
check('pesan kartu berupa teks', typeof note.pesan === 'string' && note.pesan.length > 0);
const caption = await assistantAi(db, as(guru.guru), { action: 'card_note', santri_id: target, jenis: 'profil', bagian: 'caption' });
check('caption kartu berupa teks', typeof caption.caption === 'string' && caption.caption.length > 0);

console.log('\nUmpan balik, pustaka, evaluasi');
await saveAiFeedback(db, as(guru.guru), { jenis: 'rekomendasi', targetId: rec.id, nilai: 1, komentar: 'Membantu' });
await saveAiFeedback(db, as(guru.guru), { jenis: 'rekomendasi', targetId: rec.id, nilai: -1 });
const fb = await getMyAiFeedback(db, as(guru.guru), { jenis: 'rekomendasi', targetIds: [rec.id] });
check('umpan balik diperbarui, bukan digandakan', fb[rec.id]?.nilai === -1
  && sqlite.prepare('select count(*) n from "assistant_ai_feedback"').get().n === 1);
await saveAiFeedback(db, as(guru.guru), { jenis: 'rekomendasi', targetId: rec.id, nilai: 0 });
check('umpan balik bisa dihapus', !(await getMyAiFeedback(db, as(guru.guru), { jenis: 'rekomendasi', targetIds: [rec.id] }))[rec.id]);

await expectError('guru tidak boleh menambah pustaka',
  saveAiKnowledge(db, as(guru.guru), { patch: { judul: 'Materi', isi: 'Isi materi yang cukup panjang.' } }), 'ADMIN_REQUIRED');
await expectError('pustaka terlalu pendek ditolak',
  saveAiKnowledge(db, as(admin), { patch: { judul: 'Ab', isi: 'pendek' } }), 'Judul 3');
const { id: kId } = await saveAiKnowledge(db, as(admin), { patch: { judul: 'Kaidah mad', kategori: 'Tajwid', isi: 'Mad thobi\'i dibaca dua harakat.' } });
await saveAiKnowledge(db, as(admin), { id: kId, patch: { aktif: false } });
check('pustaka nonaktif tidak tampil untuk guru', !(await listAiKnowledge(db, as(guru.guru))).some((k) => k.id === kId));
check('pustaka nonaktif tetap tampil untuk admin', (await listAiKnowledge(db, as(admin))).some((k) => k.id === kId && k.aktif === false));
await deleteAiKnowledge(db, as(admin), { id: kId });

const evaluation = await call('evaluasi', () => getAssistantAiEvaluation(db, as(admin), { from: '2026-01-01', to: jakartaToday() }));
check('evaluasi mencatat pemakaian per fitur', evaluation.pemakaian.some((p) => p.fitur === 'rekomendasi' && p.ok === 1 && p.cache === 1));
check('evaluasi mengelompokkan peringatan', evaluation.peringatan.some((p) => p.kelompok === 'dengan_saran_ai'));
await expectError('guru tidak boleh membuka evaluasi',
  getAssistantAiEvaluation(db, as(guru.guru), { from: '2026-01-01', to: '2026-02-01' }), 'ADMIN_REQUIRED');

console.log('\nStatus & penyedia Claude');
const status = await assistantAi(db, as(admin), { action: 'status' }, { ANTHROPIC_API_KEY: 'kunci-uji' });
check('status melaporkan kunci Anthropic terpasang, tanpa nilainya',
  status.providers.anthropic.configured === true && !JSON.stringify(status).includes('kunci-uji'));
await expectError('guru tidak boleh melihat status', assistantAi(db, as(guru.guru), { action: 'status' }), 'ADMIN_REQUIRED');

await saveAssistantSettings(db, as(admin), { settings: { ai: { provider: 'anthropic', model: 'claude-haiku-5-5' } } });
let sent = null;
let reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ringkasan":"OK","langkah":[],"pesan_wali":""}' }], usage: { input_tokens: 10, output_tokens: 5 } };
class FakeAnthropic {
  constructor(options) { this.options = options; }
  messages = { create: async (params) => { sent = { params, options: this.options }; return reply; } };
}
FakeAnthropic.APIError = class extends Error {};
const deps = { loadAnthropic: async () => FakeAnthropic };
const test = await assistantAi(db, as(admin), { action: 'test' }, { ANTHROPIC_API_KEY: 'kunci-uji' }, deps);
check('uji koneksi Claude berhasil', test.ok === true);
check('permintaan Claude memakai json_schema dan effort rendah',
  sent.params.output_config?.format?.type === 'json_schema' && sent.params.output_config?.effort === 'low'
  && sent.params.model === 'claude-haiku-5-5' && sent.options.apiKey === 'kunci-uji');
reply = { stop_reason: 'refusal', content: [], usage: { input_tokens: 3, output_tokens: 0 } };
await expectError('penolakan Claude dilaporkan sebagai AI_REFUSED',
  assistantAi(db, as(admin), { action: 'test' }, { ANTHROPIC_API_KEY: 'kunci-uji' }, deps), 'AI_REFUSED');
await expectError('kunci belum dipasang dilaporkan', assistantAi(db, as(admin), { action: 'test' }, {}, deps), 'AI_KEY_MISSING');

console.log('\nLeaderboard guru');
const semua = await getSantriLeaderboard(db, as(guru.guru), { page: 1, pageSize: 10 });
const kelas = await getSantriLeaderboard(db, as(guru.guru), { page: 1, pageSize: 10, scope: 'kelas' });
check('cakupan "Kelas saya" lebih sempit dari semua santri', kelas.scope === 'kelas' && kelas.total > 0 && kelas.total < semua.total,
  `${kelas.total} vs ${semua.total}`);
const ids = new Set(sqlite.prepare(`select cm."santri_id" as id from "class_memberships" cm join "classes" c on c."id" = cm."class_id"
  where cm."status" = 'active' and c."id_guru" = ?`).all(guru.guru).map((r) => r.id));
check('"Kelas saya" hanya berisi santri kelasnya', kelas.rows.every((r) => ids.has(r.id)));
const adminKelas = await getSantriLeaderboard(db, as(admin), { page: 1, pageSize: 10, scope: 'kelas' });
check('admin selalu melihat semua santri', adminKelas.scope === 'semua' && adminKelas.total === semua.total);

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
