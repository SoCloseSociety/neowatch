import type { Dict } from '../i18n';

// i18n fragment for Lot D (sw, api, stores, fresh, HlsVideo, epg).
// Add keys ONLY here, with EN, FR and RU complete, e.g.
//   'logic.example': { en: 'Watch now', fr: 'Regarder', ru: 'Смотреть' },
// Placeholders use {name}: t('logic.example', { name: value }); numbers are
// formatted with fmtNum(). Plurals: '<base>.one/.few/.many/.other' + t.n('<base>', n).
// Redefining a CORE key (lib/i18n.ts) here overrides it; never redefine a key
// from another fragment. Rules: at most 12 words per sentence, buttons verb
// first (at most 3 words), caps only in pills/overlines, no jargon, no em dash.
export const logic = {
} satisfies Dict;
