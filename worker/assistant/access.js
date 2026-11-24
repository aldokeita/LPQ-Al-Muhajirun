// Siapa boleh melihat apa di asisten.
//
// Sama dengan aturan panel di versi asalnya: admin melihat semua kelas; guru hanya kelas yang ia
// ampu (classes.id_guru); pentashih dan guru lain tidak melihat apa pun. Selama mode senyap
// aktif, selain admin tidak mendapat data asisten sama sekali.

import { RpcError } from '../rpc/santri.js';
import { currentUserRole } from '../auth/predicates.js';
import { settingsFor } from './settings.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const requireLogin = (ctx) => {
  if (!ctx.userId) throw new RpcError('AUTH_REQUIRED', 401);
};

// Peran pemanggil beserta kelas-kelas yang boleh ia lihat. classIds null berarti semua kelas.
export const assistantScope = async (ctx) => {
  requireLogin(ctx);
  if (ctx.assistantScope) return ctx.assistantScope;
  const role = await currentUserRole(ctx);
  const { settings } = await settingsFor(ctx);
  let classIds = new Set();
  if (role === 'admin') {
    classIds = null;
  } else if (role === 'guru') {
    const { results } = await ctx.db
      .prepare('select "id" from "classes" where "id_guru" = ? and "deleted_at" is null')
      .bind(ctx.userId).all();
    classIds = new Set((results || []).map((r) => r.id));
  }
  ctx.assistantScope = {
    role,
    admin: role === 'admin',
    classIds,
    silent: Boolean(settings.silent_mode),
    // Guru melihat data asisten hanya bila mode senyap dimatikan.
    blind: role !== 'admin' && Boolean(settings.silent_mode),
    settings,
  };
  return ctx.assistantScope;
};

export const canSeeClass = (scope, classId) => scope.admin || Boolean(classId && scope.classIds?.has(classId));

// Daftar kelas untuk disisipkan ke SQL lewat json_each. Admin memakai null (tanpa saringan).
export const classFilterParam = (scope) => (scope.admin ? null : JSON.stringify([...(scope.classIds || [])]));

export const requireAssistantRole = (scope) => {
  if (!['admin', 'guru', 'pentashih'].includes(scope.role)) throw new RpcError('CLASS_ACCESS_DENIED', 403);
};

// Peringatan tampak bagi admin, atau bagi guru pengampu kelasnya bila peringatan itu dan
// pengaturannya tidak sedang senyap.
export const alertVisible = (scope, alert) => scope.admin
  || (!Number(alert.senyap) && !scope.silent && canSeeClass(scope, alert.class_id));

export const parseJson = (text, fallback = null) => {
  if (text === null || text === undefined) return fallback;
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

export const nowIso = () => new Date().toISOString();
