import { fetchWebsiteContentValue } from '@/lib/publicContentAdapters';
import { badgesForSantri, SANTRI_BADGES_KEY } from '@/lib/santriBadges';

// Konfigurasi badge kecil dan jarang berubah, jadi kios absensi memakainya ulang selama satu
// menit di antara pemindaian alih-alih membacanya setiap kali kartu ditempel.
const BADGE_CACHE_MS = 60 * 1000;
let badgeCache = { at: 0, promise: null };

export const loadSantriBadgeConfig = () => {
  if (badgeCache.promise && Date.now() - badgeCache.at < BADGE_CACHE_MS) return badgeCache.promise;
  // Gagal membaca berarti tanpa badge; absensi tidak boleh ikut gagal karenanya.
  const promise = fetchWebsiteContentValue(SANTRI_BADGES_KEY)
    .then(({ data, error }) => (error ? null : data || null))
    .catch(() => null);
  badgeCache = { at: Date.now(), promise };
  return promise;
};

export const getSantriBadgeIds = async (santriId) => {
  if (!santriId) return [];
  const config = await loadSantriBadgeConfig();
  return badgesForSantri(config, santriId).map((badge) => badge.id);
};
