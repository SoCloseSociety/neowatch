import type { Dict } from '../i18n';

// i18n fragment for Lot A (Home, Rail, ChannelCard, ChannelGrid, FilterBar, ProgramSearch).
// Add keys ONLY here, with EN, FR and RU complete, e.g.
//   'home.example': { en: 'Watch now', fr: 'Regarder', ru: 'Смотреть' },
// Placeholders use {name}: t('home.example', { name: value }); numbers are
// formatted with fmtNum(). Plurals: '<base>.one/.few/.many/.other' + t.n('<base>', n).
// Redefining a CORE key (lib/i18n.ts) here overrides it; never redefine a key
// from another fragment. Rules: at most 12 words per sentence, buttons verb
// first (at most 3 words), caps only in pills/overlines, no jargon, no em dash.
export const home = {
  // Hero (spec 2.2)
  'home.heroEmptyTitle': { en: 'Free live TV from everywhere', fr: 'La télé en direct, du monde entier', ru: 'Бесплатное ТВ со всего мира' },
  'home.heroEmptyBody': { en: 'Pick a channel below, or let us choose.', fr: 'Choisissez une chaîne, ou laissez-nous choisir.', ru: 'Выберите канал или доверьтесь нам.' },
  'hero.onAir': { en: 'On air now.', fr: 'À l’antenne maintenant.', ru: 'Сейчас в эфире.' },
  'home.surpriseNone': { en: 'No channel is available right now.', fr: 'Aucune chaîne disponible pour le moment.', ru: 'Сейчас нет доступных каналов.' },
  // Home states
  'home.error': { en: 'Home is unavailable right now.', fr: 'L’accueil est indisponible pour le moment.', ru: 'Главная сейчас недоступна.' },
  'home.errorBody': { en: 'Check your connection, then try again.', fr: 'Vérifiez votre connexion, puis réessayez.', ru: 'Проверьте соединение и повторите.' },
  // Rows (spec 2.3)
  'home.myListTitle': { en: 'My list', fr: 'Ma liste', ru: 'Мой список' },
  // Server rail titles, by rail key (the server's localized title is the fallback)
  'rail.foot': { en: 'Football & sport', fr: 'Football & sport', ru: 'Футбол и спорт' },
  'rail.fr': { en: 'France', fr: 'France', ru: 'Франция' },
  'rail.uk': { en: 'United Kingdom', fr: 'Royaume-Uni', ru: 'Великобритания' },
  'rail.de': { en: 'Germany', fr: 'Allemagne', ru: 'Германия' },
  'rail.it': { en: 'Italy', fr: 'Italie', ru: 'Италия' },
  'rail.es': { en: 'Spain', fr: 'Espagne', ru: 'Испания' },
  'rail.news': { en: 'News', fr: 'Actualités', ru: 'Новости' },
  'rail.movies': { en: 'Movies', fr: 'Films', ru: 'Фильмы' },
  'rail.series': { en: 'Series', fr: 'Séries', ru: 'Сериалы' },
  'rail.kids': { en: 'Kids', fr: 'Enfants', ru: 'Детям' },
  'rail.music': { en: 'Music', fr: 'Musique', ru: 'Музыка' },
  'rail.documentary': { en: 'Documentaries', fr: 'Documentaires', ru: 'Документальные' },
  'rail.entertainment': { en: 'Entertainment', fr: 'Divertissement', ru: 'Развлечения' },
  'rail.general': { en: 'Popular channels', fr: 'Chaînes populaires', ru: 'Популярные каналы' },
  // Grid states (spec 2.9)
  'grid.error': { en: 'Channels are unavailable right now.', fr: 'Les chaînes sont indisponibles pour le moment.', ru: 'Каналы сейчас недоступны.' },
  'grid.noMatchBody': { en: 'Try another word or fewer filters.', fr: 'Essayez un autre mot ou moins de filtres.', ru: 'Попробуйте другое слово или меньше фильтров.' },
  'grid.noFavBody': { en: 'Open a channel, then add it to your list.', fr: 'Ouvrez une chaîne, puis ajoutez-la à votre liste.', ru: 'Откройте канал и добавьте его в список.' },
  'grid.clearFilters': { en: 'Clear filters', fr: 'Effacer les filtres', ru: 'Сбросить фильтры' },
  // Filter bar
  'filterbar.category': { en: 'Category', fr: 'Catégorie', ru: 'Категория' },
  'filterbar.country': { en: 'Country', fr: 'Pays', ru: 'Страна' },
  'filterbar.language': { en: 'Language', fr: 'Langue', ru: 'Язык' },
  'filterbar.filters': { en: 'Filters', fr: 'Filtres', ru: 'Фильтры' },
  'filterbar.listFrom': { en: 'list from {time}', fr: 'liste de {time}', ru: 'список от {time}' },
  'filterbar.checking': { en: 'checking…', fr: 'vérification…', ru: 'проверка…' },
  // Programme search row
  'count.shows.one': { en: '{n} show', fr: '{n} émission', ru: '{n} передача' },
  'count.shows.few': { en: '{n} shows', fr: '{n} émissions', ru: '{n} передачи' },
  'count.shows.many': { en: '{n} shows', fr: '{n} émissions', ru: '{n} передач' },
  'count.shows.other': { en: '{n} shows', fr: '{n} émissions', ru: '{n} передачи' },
  // Footer
  'footer.copyright': { en: '© {year} NeoWatch · free streams listed by iptv-org', fr: '© {year} NeoWatch · flux libres recensés par iptv-org', ru: '© {year} NeoWatch · открытые потоки из каталога iptv-org' },
  'count.countries.one': { en: '{n} country', fr: '{n} pays', ru: '{n} страна' },
  'count.countries.few': { en: '{n} countries', fr: '{n} pays', ru: '{n} страны' },
  'count.countries.many': { en: '{n} countries', fr: '{n} pays', ru: '{n} стран' },
  'count.countries.other': { en: '{n} countries', fr: '{n} pays', ru: '{n} страны' },
  'search.onAirAndNext': { en: 'On air and coming up', fr: 'À l’antenne et à venir', ru: 'В эфире и далее' },
} satisfies Dict;
