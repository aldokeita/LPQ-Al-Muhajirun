-- Asisten guru: panel "Perlu Perhatian", Asisten AI, rapor wali, dan kartu santri.
--
-- Diadopsi dari LPQ Al-Fath Maulana (migrasi Supabase 20261112–20261124), ditulis ulang untuk
-- D1. Berbeda dari 0001, berkas ini ditulis tangan: tabelnya lahir di D1, bukan dari dump
-- Postgres, jadi tidak ada generator yang menghasilkannya.
--
-- Tabel-tabel ini sengaja TIDAK didaftarkan di worker/data/schema-manifest.js. Seluruh baca
-- tulisnya lewat RPC di worker/assistant, yang memeriksa hak akses dan mode senyap sendiri.
-- Tanpa entri manifest, /api/data menolak tabel ini mentah-mentah, sehingga tidak ada jalan
-- samping yang melewati pemeriksaan itu.
--
-- Pemetaan tipe sama dengan 0001: uuid -> TEXT (dibuat di Worker), timestamptz -> TEXT ISO UTC,
-- date -> TEXT YYYY-MM-DD, boolean -> INTEGER 0/1, jsonb dan array -> TEXT berisi JSON.
--
-- Terapkan ke produksi dengan:
--   npx wrangler d1 execute lpq-al-muhajirun --remote --file migrations-d1/0003_assistant.sql

PRAGMA foreign_keys = ON;

-- Pengaturan berversi dan hanya-tambah: setiap simpanan admin menjadi baris baru, sehingga
-- standar yang berlaku pada tanggal tertentu tetap bisa ditelusuri. Tanpa baris sama sekali,
-- yang berlaku adalah nilai bawaan di worker/assistant/settings.js.
CREATE TABLE "assistant_settings" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "settings" TEXT NOT NULL,
  "created_by" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT "assistant_settings_object" CHECK (json_valid("settings") AND json_type("settings") = 'object'),
  CONSTRAINT "assistant_settings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE TABLE "assistant_alerts" (
  "id" TEXT NOT NULL,
  "santri_id" TEXT NOT NULL,
  "class_id" TEXT NOT NULL,
  "rule" TEXT NOT NULL,
  "tingkat" TEXT NOT NULL,
  "alasan" TEXT NOT NULL,
  "detail" TEXT NOT NULL DEFAULT '{}',
  "dedupe_key" TEXT NOT NULL,
  "episode_key" TEXT NOT NULL,
  "senyap" INTEGER NOT NULL DEFAULT 0,
  "ref_date" TEXT NOT NULL,
  "settings_id" INTEGER,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "assistant_alerts_rule_check" CHECK ("rule" IN (
    'absen_beruntun', 'jilid_lama', 'kehadiran_bulanan', 'hafalan_macet', 'hafalan_wajib_belum_lulus',
    'murojaah_belum_ditinjau'
  )),
  CONSTRAINT "assistant_alerts_tingkat_check" CHECK ("tingkat" IN ('rendah', 'sedang', 'tinggi')),
  CONSTRAINT "assistant_alerts_alasan_check" CHECK (length(trim("alasan")) BETWEEN 1 AND 1000),
  CONSTRAINT "assistant_alerts_detail_json" CHECK (json_valid("detail")),
  CONSTRAINT "assistant_alerts_santri_id_fkey" FOREIGN KEY ("santri_id") REFERENCES "santri" ("id") ON DELETE CASCADE,
  CONSTRAINT "assistant_alerts_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes" ("id") ON DELETE CASCADE,
  CONSTRAINT "assistant_alerts_settings_id_fkey" FOREIGN KEY ("settings_id") REFERENCES "assistant_settings" ("id")
);

-- Satu peringatan per tahap pengingat dalam satu episode. Kuncinya dipisah per status senyap,
-- supaya episode yang berjalan saat mode senyap dimatikan tetap muncul ke guru.
CREATE UNIQUE INDEX "assistant_alerts_unique" ON "assistant_alerts" ("santri_id", "rule", "dedupe_key", "senyap");
CREATE INDEX "assistant_alerts_class_idx" ON "assistant_alerts" ("class_id", "created_at");
CREATE INDEX "assistant_alerts_episode_idx" ON "assistant_alerts" ("santri_id", "rule", "episode_key");
CREATE INDEX "assistant_alerts_created_idx" ON "assistant_alerts" ("created_at");

CREATE TABLE "assistant_alert_decisions" (
  "id" TEXT NOT NULL,
  "alert_id" TEXT NOT NULL,
  "keputusan" TEXT NOT NULL,
  "catatan" TEXT,
  "diputuskan_oleh" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "assistant_alert_decisions_keputusan_check" CHECK (
    "keputusan" IN ('ditangani', 'wali_dihubungi', 'diabaikan', 'peringatan_keliru')
  ),
  CONSTRAINT "assistant_alert_decisions_catatan_check" CHECK ("catatan" IS NULL OR length("catatan") <= 500),
  CONSTRAINT "assistant_alert_decisions_abaikan_alasan" CHECK (
    "keputusan" <> 'diabaikan' OR length(trim(coalesce("catatan", ''))) > 0
  ),
  CONSTRAINT "assistant_alert_decisions_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "assistant_alerts" ("id") ON DELETE CASCADE,
  CONSTRAINT "assistant_alert_decisions_oleh_fkey" FOREIGN KEY ("diputuskan_oleh") REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE INDEX "assistant_alert_decisions_alert_idx" ON "assistant_alert_decisions" ("alert_id", "created_at");

-- Koreksi guru: santri sebenarnya hadir pada tanggal itu (kartu hilang atau lupa tap).
-- Tap RFID di tabel attendance tidak pernah disentuh.
CREATE TABLE "attendance_presence_corrections" (
  "id" TEXT NOT NULL,
  "santri_id" TEXT NOT NULL,
  "class_id" TEXT NOT NULL,
  "tanggal" TEXT NOT NULL,
  "keterangan" TEXT,
  "alert_id" TEXT,
  "dikoreksi_oleh" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "attendance_presence_corrections_keterangan_check" CHECK ("keterangan" IS NULL OR length("keterangan") <= 300),
  CONSTRAINT "attendance_presence_corrections_santri_id_fkey" FOREIGN KEY ("santri_id") REFERENCES "santri" ("id") ON DELETE CASCADE,
  CONSTRAINT "attendance_presence_corrections_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes" ("id") ON DELETE CASCADE,
  CONSTRAINT "attendance_presence_corrections_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "assistant_alerts" ("id") ON DELETE SET NULL,
  CONSTRAINT "attendance_presence_corrections_oleh_fkey" FOREIGN KEY ("dikoreksi_oleh") REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "attendance_presence_corrections_unique" ON "attendance_presence_corrections" ("santri_id", "tanggal");
CREATE INDEX "attendance_presence_corrections_class_idx" ON "attendance_presence_corrections" ("class_id", "tanggal");

CREATE TABLE "wali_followups" (
  "id" TEXT NOT NULL,
  "santri_id" TEXT NOT NULL,
  "class_id" TEXT NOT NULL,
  "guru_id" TEXT,
  "alert_id" TEXT,
  "tanggal_kontak" TEXT NOT NULL,
  "saluran" TEXT NOT NULL,
  "hasil" TEXT NOT NULL,
  "catatan" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "wali_followups_saluran_check" CHECK ("saluran" IN ('whatsapp', 'telepon', 'tatap_muka', 'lainnya')),
  CONSTRAINT "wali_followups_hasil_check" CHECK ("hasil" IN ('terhubung', 'tidak_merespons', 'janji_hadir', 'lainnya')),
  CONSTRAINT "wali_followups_catatan_check" CHECK ("catatan" IS NULL OR length("catatan") <= 500),
  CONSTRAINT "wali_followups_santri_id_fkey" FOREIGN KEY ("santri_id") REFERENCES "santri" ("id") ON DELETE CASCADE,
  CONSTRAINT "wali_followups_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes" ("id") ON DELETE CASCADE,
  CONSTRAINT "wali_followups_guru_id_fkey" FOREIGN KEY ("guru_id") REFERENCES "users" ("id") ON DELETE SET NULL,
  CONSTRAINT "wali_followups_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "assistant_alerts" ("id") ON DELETE SET NULL
);

CREATE INDEX "wali_followups_santri_idx" ON "wali_followups" ("santri_id", "tanggal_kontak");

-- Hanya-tambah. Di Postgres penjaganya memeriksa pg_trigger_depth agar aksi foreign key tetap
-- lolos; SQLite tidak punya padanannya. Jadi pemicunya dibatasi pada kolom isi saja (UPDATE OF):
-- aksi ON DELETE SET NULL hanya menyentuh kolom rujukan, sehingga penghapusan permanen santri
-- oleh admin tidak tertahan, sementara perubahan isi catatan selalu ditolak.
CREATE TRIGGER "assistant_alerts_append_only"
BEFORE UPDATE OF "santri_id", "class_id", "rule", "tingkat", "alasan", "detail", "dedupe_key", "episode_key",
  "senyap", "ref_date", "created_at" ON "assistant_alerts"
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY: assistant_alerts hanya bisa ditambah');
END;

CREATE TRIGGER "assistant_alert_decisions_append_only"
BEFORE UPDATE OF "alert_id", "keputusan", "catatan", "created_at" ON "assistant_alert_decisions"
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY: assistant_alert_decisions hanya bisa ditambah');
END;

CREATE TRIGGER "attendance_presence_corrections_append_only"
BEFORE UPDATE OF "santri_id", "class_id", "tanggal", "keterangan", "created_at" ON "attendance_presence_corrections"
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY: attendance_presence_corrections hanya bisa ditambah');
END;

CREATE TRIGGER "wali_followups_append_only"
BEFORE UPDATE OF "santri_id", "class_id", "tanggal_kontak", "saluran", "hasil", "catatan", "created_at" ON "wali_followups"
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY: wali_followups hanya bisa ditambah');
END;

CREATE TRIGGER "assistant_settings_append_only"
BEFORE UPDATE OF "settings", "created_at" ON "assistant_settings"
BEGIN
  SELECT RAISE(ABORT, 'APPEND_ONLY: assistant_settings hanya bisa ditambah');
END;

-- ===== Asisten AI =====
-- Kunci API hanya ada sebagai secret Worker, tidak pernah di basis data atau peramban.

CREATE TABLE "assistant_ai_recommendations" (
  "id" TEXT NOT NULL,
  "santri_id" TEXT NOT NULL,
  "requested_by" TEXT,
  "alert_ids" TEXT NOT NULL DEFAULT '[]',
  "input_hash" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "hasil" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "assistant_ai_recommendations_santri_id_fkey" FOREIGN KEY ("santri_id") REFERENCES "santri" ("id") ON DELETE CASCADE,
  CONSTRAINT "assistant_ai_recommendations_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE INDEX "assistant_ai_recommendations_santri_idx" ON "assistant_ai_recommendations" ("santri_id", "created_at");
CREATE INDEX "assistant_ai_recommendations_hash_idx" ON "assistant_ai_recommendations" ("santri_id", "input_hash");

-- Setiap panggilan dicatat untuk batas harian per pengguna dan anggaran bulanan lembaga.
CREATE TABLE "assistant_ai_usage" (
  "id" TEXT NOT NULL,
  "user_id" TEXT,
  "santri_id" TEXT,
  "fitur" TEXT NOT NULL DEFAULT 'rekomendasi',
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "input_tokens" INTEGER NOT NULL DEFAULT 0,
  "output_tokens" INTEGER NOT NULL DEFAULT 0,
  "biaya_usd" REAL NOT NULL DEFAULT 0,
  "galat" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "assistant_ai_usage_status_check" CHECK ("status" IN ('ok', 'cache', 'gagal', 'uji')),
  CONSTRAINT "assistant_ai_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL,
  CONSTRAINT "assistant_ai_usage_santri_id_fkey" FOREIGN KEY ("santri_id") REFERENCES "santri" ("id") ON DELETE SET NULL
);

CREATE INDEX "assistant_ai_usage_created_idx" ON "assistant_ai_usage" ("created_at");
CREATE INDEX "assistant_ai_usage_user_idx" ON "assistant_ai_usage" ("user_id", "created_at");

CREATE TABLE "assistant_ai_class_insights" (
  "id" TEXT NOT NULL,
  "class_id" TEXT NOT NULL,
  "requested_by" TEXT,
  "input_hash" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "hasil" TEXT NOT NULL,
  "kode_santri" TEXT NOT NULL DEFAULT '{}',
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "assistant_ai_class_insights_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes" ("id") ON DELETE CASCADE,
  CONSTRAINT "assistant_ai_class_insights_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE INDEX "assistant_ai_class_insights_class_idx" ON "assistant_ai_class_insights" ("class_id", "created_at");

-- Percakapan hanya bisa dibaca dan dihapus pemiliknya.
CREATE TABLE "assistant_ai_conversations" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "class_id" TEXT,
  "santri_id" TEXT,
  "judul" TEXT NOT NULL DEFAULT 'Percakapan baru',
  "sumber" TEXT NOT NULL DEFAULT 'dasbor',
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "assistant_ai_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
  CONSTRAINT "assistant_ai_conversations_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes" ("id") ON DELETE SET NULL,
  CONSTRAINT "assistant_ai_conversations_santri_id_fkey" FOREIGN KEY ("santri_id") REFERENCES "santri" ("id") ON DELETE SET NULL
);

CREATE INDEX "assistant_ai_conversations_user_idx" ON "assistant_ai_conversations" ("user_id", "updated_at");

CREATE TABLE "assistant_ai_messages" (
  "id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "assistant_ai_messages_role_check" CHECK ("role" IN ('user', 'assistant')),
  CONSTRAINT "assistant_ai_messages_content_check" CHECK (length("content") <= 8000),
  CONSTRAINT "assistant_ai_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "assistant_ai_conversations" ("id") ON DELETE CASCADE
);

CREATE INDEX "assistant_ai_messages_conversation_idx" ON "assistant_ai_messages" ("conversation_id", "created_at");

CREATE TABLE "assistant_ai_feedback" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "jenis" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "nilai" INTEGER NOT NULL,
  "komentar" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "assistant_ai_feedback_jenis_check" CHECK ("jenis" IN ('rekomendasi', 'kelas', 'chat', 'rapor')),
  CONSTRAINT "assistant_ai_feedback_nilai_check" CHECK ("nilai" IN (-1, 1)),
  CONSTRAINT "assistant_ai_feedback_komentar_check" CHECK ("komentar" IS NULL OR length("komentar") <= 500),
  CONSTRAINT "assistant_ai_feedback_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "assistant_ai_feedback_unique" ON "assistant_ai_feedback" ("user_id", "jenis", "target_id");

-- Pustaka materi Qiroati yang ikut dikirim ke AI sebagai rujukan.
CREATE TABLE "assistant_ai_knowledge" (
  "id" TEXT NOT NULL,
  "judul" TEXT NOT NULL,
  "kategori" TEXT NOT NULL DEFAULT 'Umum',
  "isi" TEXT NOT NULL,
  "aktif" INTEGER NOT NULL DEFAULT 1,
  "created_by" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "assistant_ai_knowledge_judul_check" CHECK (length(trim("judul")) BETWEEN 3 AND 120),
  CONSTRAINT "assistant_ai_knowledge_kategori_check" CHECK (length("kategori") <= 40),
  CONSTRAINT "assistant_ai_knowledge_isi_check" CHECK (length(trim("isi")) BETWEEN 10 AND 8000),
  CONSTRAINT "assistant_ai_knowledge_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE TABLE "assistant_ai_reports" (
  "id" TEXT NOT NULL,
  "santri_id" TEXT NOT NULL,
  "bulan" TEXT NOT NULL,
  "requested_by" TEXT,
  "input_hash" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "hasil" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY ("id"),
  CONSTRAINT "assistant_ai_reports_bulan_check" CHECK ("bulan" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  CONSTRAINT "assistant_ai_reports_santri_id_fkey" FOREIGN KEY ("santri_id") REFERENCES "santri" ("id") ON DELETE CASCADE,
  CONSTRAINT "assistant_ai_reports_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE INDEX "assistant_ai_reports_santri_idx" ON "assistant_ai_reports" ("santri_id", "created_at");
