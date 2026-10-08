import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { home } from './i18n/home';
import { shell } from './i18n/shell';
import { pages } from './i18n/pages';
import { logic } from './i18n/logic';

// i18n core (Lot 0). One dictionary, merged from:
//   CORE (this file: shared keys, owned by Lot 0 / the integrator)
//   + lib/i18n/home.ts (Lot A) + shell.ts (Lot B) + pages.ts (Lot C) + logic.ts (Lot D).
// A fragment key with the same name as a CORE key overrides it (that is how a
// lot changes shared copy without editing this file; the integrator folds it
// back). Two fragments must never define the same key (dev warning).
//
// Language: a persisted choice wins; otherwise navigator.languages is matched
// against fr/ru, else English. Lookup falls back to English, then to the key.

export type Lang = 'fr' | 'en' | 'ru';

/** One entry: EN, FR and RU are all required. */
export type Tr = Record<Lang, string>;
/** A dictionary fragment: `export const home = { 'home.x': { en, fr, ru } } satisfies Dict;` */
export type Dict = Record<string, Tr>;

export const LANGS: { code: Lang; label: string; flag: string }[] = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
];

/** BCP 47 locale used by Intl for numbers, times and dates in each UI language. */
export const LOCALES: Record<Lang, string> = { en: 'en-GB', fr: 'fr-FR', ru: 'ru-RU' };

const CORE = {
  // TopBar
  'search.placeholder': { fr: 'Chercher une chaîne', en: 'Search channels', ru: 'Найти канал' },
  'search.clear': { fr: 'Effacer', en: 'Clear', ru: 'Очистить' },
  'search.recent': { fr: 'Recherches récentes', en: 'Recent searches', ru: 'Недавние запросы' },
  'top.premium': { fr: 'Premium', en: 'Premium', ru: 'Премиум' },
  'top.install': { fr: 'Installer', en: 'Install', ru: 'Установить' },
  'top.multi': { fr: 'Multi-écran', en: 'Multi-view', ru: 'Мультиэкран' },
  'top.login': { fr: 'Connexion', en: 'Sign in', ru: 'Войти' },
  'top.account': { fr: 'Mon compte', en: 'My account', ru: 'Мой аккаунт' },
  // Promo strip
  'promo.premiumMsg': { fr: 'Épinglez vos catégories, vos réglages sur tous vos écrans.', en: 'Pin your categories, keep your settings on every screen.', ru: 'Закрепите категории, настройки на всех экранах.' },
  'promo.installMsg': { fr: 'Installez NeoWatch sur cet appareil.', en: 'Install NeoWatch on this device.', ru: 'Установите NeoWatch на это устройство.' },
  'promo.discover': { fr: 'Voir les offres', en: 'See plans', ru: 'Тарифы' },
  // Home
  'home.watch': { fr: 'Regarder', en: 'Watch now', ru: 'Смотреть' },
  'home.myList': { fr: 'Ajouter à ma liste', en: 'Add to my list', ru: 'В мой список' },
  'home.inMyList': { fr: 'Dans ma liste', en: 'In my list', ru: 'В списке' },
  'home.browseCategories': { fr: 'Parcourir', en: 'Browse', ru: 'Обзор' },
  'home.liveNow': { fr: 'En direct', en: 'Live now', ru: 'Сейчас в эфире' },
  'home.resume': { fr: 'Reprendre', en: 'Continue watching', ru: 'Продолжить' },
  'home.seeAll': { fr: 'Tout voir', en: 'See all', ru: 'Все' },
  // FilterBar
  'filter.allCategories': { fr: 'Toutes catégories', en: 'All categories', ru: 'Все категории' },
  'filter.allCountries': { fr: 'Tous pays', en: 'All countries', ru: 'Все страны' },
  'filter.allLanguages': { fr: 'Toutes langues', en: 'All languages', ru: 'Все языки' },
  'filter.online': { fr: 'En ligne seulement', en: 'Online only', ru: 'Только в эфире' },
  'filter.noGeo': { fr: 'Lisible ici', en: 'Playable here', ru: 'Доступно здесь' },
  'filter.allChannels': { fr: 'Toutes les chaînes', en: 'All channels', ru: 'Все каналы' },
  // Settings
  'set.title': { fr: 'Apparence & lecture', en: 'Appearance & playback', ru: 'Вид и воспроизведение' },
  'set.language': { fr: 'Langue', en: 'Language', ru: 'Язык' },
  'set.theme': { fr: 'Style', en: 'Style', ru: 'Стиль' },
  'set.density': { fr: 'Taille de la grille', en: 'Grid size', ru: 'Размер сетки' },
  'set.playback': { fr: 'Lecture', en: 'Playback', ru: 'Воспроизведение' },
  // Player
  'player.interrupted': { fr: 'Cette chaîne ne répond pas.', en: 'This channel is not answering.', ru: 'Канал не отвечает.' },
  'player.retry': { fr: 'Réessayer', en: 'Try again', ru: 'Повторить' },
  'player.forceProxy': { fr: 'Essayer une autre voie', en: 'Try another route', ru: 'Другой маршрут' },
  'player.connecting': { fr: 'Connexion…', en: 'Connecting…', ru: 'Подключение…' },
  'player.viaProxy': { fr: 'Essai d’une autre voie…', en: 'Trying another route…', ru: 'Пробуем другой маршрут…' },
  'player.retrying': { fr: 'Nouvelle tentative…', en: 'Retrying…', ru: 'Повторная попытка…' },
  'player.buffering': { fr: 'Mise en mémoire tampon…', en: 'Buffering…', ru: 'Буферизация…' },
  'player.audioTrack': { fr: 'Audio', en: 'Audio', ru: 'Аудио' },
  'player.subtitles': { fr: 'Sous-titres', en: 'Subtitles', ru: 'Субтитры' },
  'player.off': { fr: 'Désactivés', en: 'Off', ru: 'Выкл.' },
  // Home misc
  'home.adLabel': { fr: 'PUBLICITÉ', en: 'AD', ru: 'РЕКЛАМА' },
  // QR / device pairing (sign in a TV by scanning with the phone)
  'qr.connectPhone': { en: 'Use my phone', fr: 'Utiliser mon téléphone', ru: 'Через телефон' },
  'qr.title': { fr: 'Connexion par QR', en: 'Sign in by QR', ru: 'Вход по QR' },
  'qr.expired': { fr: 'Code expiré.', en: 'Code expired.', ru: 'Код истёк.' },
  'qr.retry': { fr: 'Nouveau code', en: 'New code', ru: 'Новый код' },
  // Phone-side approval page (/link)
  'link.title': { fr: 'Connecter une TV', en: 'Connect a TV', ru: 'Подключить ТВ' },
  'link.needLogin': { en: 'Sign in on this phone to connect the TV.', fr: 'Connectez-vous sur ce téléphone pour connecter la TV.', ru: 'Войдите на этом телефоне, чтобы подключить ТВ.' },
  'link.signin': { fr: 'Se connecter', en: 'Sign in', ru: 'Войти' },
  'link.invalid': { fr: 'Code invalide ou expiré.', en: 'Code invalid or expired.', ru: 'Код неверен или истёк.' },
  'link.noCode': { fr: 'Aucun code fourni.', en: 'No code provided.', ru: 'Код не указан.' },
  // Player controls & status
  'player.errorHint': { fr: 'Elle est peut-être bloquée dans votre pays.', en: 'It may be blocked in your country.', ru: 'Возможно, канал недоступен в вашей стране.' },
  'player.play': { fr: 'Lecture (Espace)', en: 'Play (Space)', ru: 'Воспроизвести (пробел)' },
  'player.pause': { fr: 'Pause (Espace)', en: 'Pause (Space)', ru: 'Пауза (пробел)' },
  'player.mute': { fr: 'Couper le son (M)', en: 'Mute (M)', ru: 'Без звука (M)' },
  'player.quality': { fr: 'Qualité', en: 'Quality', ru: 'Качество' },
  'player.pip': { fr: 'Picture-in-picture', en: 'Picture-in-picture', ru: 'Картинка в картинке' },
  'player.fullscreen': { fr: 'Plein écran (F)', en: 'Fullscreen (F)', ru: 'Во весь экран (F)' },
  'player.proxyTitle': { fr: 'Essayer une autre voie', en: 'Try another route', ru: 'Другой маршрут' },
  'player.volume': { fr: 'Volume', en: 'Volume', ru: 'Громкость' },
  // Shared card / control actions
  'common.addMulti': { fr: 'Ajouter au multi-écran', en: 'Add to multi-view', ru: 'В мультиэкран' },
  'common.prev': { fr: 'Précédent', en: 'Previous', ru: 'Назад' },
  'common.next': { fr: 'Suivant', en: 'Next', ru: 'Вперёд' },
  // Grid empty states
  'grid.noFav': { fr: 'Votre liste est vide.', en: 'Your list is empty.', ru: 'Ваш список пуст.' },
  'grid.noMatch': { fr: 'Aucune chaîne trouvée.', en: 'No channel found.', ru: 'Канал не найден.' },
  // Auth gate + login form
  'gate.body': { fr: 'Connectez-vous pour accéder à toutes les chaînes en direct.', en: 'Sign in to access all live channels.', ru: 'Войдите, чтобы смотреть все каналы в прямом эфире.' },
  'login.name': { fr: 'Nom (optionnel)', en: 'Name (optional)', ru: 'Имя (необязательно)' },
  'login.email': { fr: 'Email', en: 'Email', ru: 'Эл. почта' },
  'login.password': { fr: 'Mot de passe', en: 'Password', ru: 'Пароль' },
  'login.showPw': { fr: 'Afficher', en: 'Show', ru: 'Показать' },
  'login.hidePw': { fr: 'Masquer', en: 'Hide', ru: 'Скрыть' },
  'login.signIn': { fr: 'Se connecter', en: 'Sign in', ru: 'Войти' },
  'login.create': { fr: 'Créer mon compte', en: 'Create my account', ru: 'Создать аккаунт' },
  'login.tagline': { fr: 'Toutes les chaînes sont gratuites.', en: 'Every channel is free.', ru: 'Все каналы бесплатны.' },
  'login.welcomeBack': { fr: 'Content de vous revoir', en: 'Good to see you again', ru: 'Рады видеть вас снова' },
  'login.welcomeNew': { fr: 'Des milliers de chaînes en direct vous attendent', en: 'Thousands of live channels are waiting for you', ru: 'Тысячи каналов в прямом эфире ждут вас' },
  'login.tabLogin': { fr: 'Connexion', en: 'Sign in', ru: 'Вход' },
  'login.tabRegister': { fr: 'Créer un compte', en: 'Create account', ru: 'Создать аккаунт' },
  // Account panel
  'account.email': { fr: 'Email', en: 'Email', ru: 'Эл. почта' },
  'account.role': { fr: 'Rôle', en: 'Role', ru: 'Роль' },
  'account.plan': { fr: 'Abonnement', en: 'Plan', ru: 'Подписка' },
  'account.free': { fr: 'Gratuit', en: 'Free', ru: 'Бесплатный' },
  'account.cancel': { fr: 'Résilier le Premium', en: 'Cancel Premium', ru: 'Отменить Premium' },
  'account.upgrade': { fr: 'Passer Premium', en: 'Go Premium', ru: 'Перейти на Premium' },
  'account.password': { fr: 'Mot de passe', en: 'Password', ru: 'Пароль' },
  'account.currentPw': { fr: 'Mot de passe actuel', en: 'Current password', ru: 'Текущий пароль' },
  'account.logout': { fr: 'Se déconnecter', en: 'Sign out', ru: 'Выйти' },
  'account.prefs': { fr: 'Préférences d’affichage', en: 'Viewing preferences', ru: 'Настройки отображения' },
  'account.delete': { fr: 'Supprimer mon compte', en: 'Delete my account', ru: 'Удалить аккаунт' },
  'account.deleteConfirm': { fr: 'Supprimer définitivement', en: 'Delete permanently', ru: 'Удалить навсегда' },
  // Programme search strip
  // Internet radio
  'radio.title': { fr: 'Radios', en: 'Radio', ru: 'Радио' },
  'radio.subtitle': { fr: 'Les radios du monde entier, en direct.', en: 'Live radio from around the world.', ru: 'Радио со всего мира в прямом эфире.' },
  'radio.empty': { fr: 'Aucune radio trouvée.', en: 'No station found.', ru: 'Станция не найдена.' },
  'radio.playing': { fr: 'En écoute', en: 'Now playing', ru: 'Сейчас играет' },
  'radio.connecting': { fr: 'Connexion…', en: 'Connecting…', ru: 'Подключение…' },
  'radio.error': { fr: 'Cette radio ne répond pas. Essayez-en une autre.', en: 'This station is not answering. Try another one.', ru: 'Станция не отвечает. Попробуйте другую.' },
  'radio.stop': { fr: 'Arrêter', en: 'Stop', ru: 'Стоп' },
  // Multi-view
  'multi.focus': { fr: 'Focus', en: 'Focus', ru: 'Фокус' },
  'multi.mosaic': { fr: 'Mosaïque', en: 'Mosaic', ru: 'Мозаика' },
  'multi.title': { fr: 'Multi-écran', en: 'Multi-view', ru: 'Мультиэкран' },
  'multi.clear': { fr: 'Vider', en: 'Clear', ru: 'Очистить' },
  'multi.audio': { fr: 'Activer le son', en: 'Use this audio', ru: 'Включить звук' },
  'multi.remove': { fr: 'Retirer', en: 'Remove', ru: 'Убрать' },
  'multi.layout': { fr: 'Disposition', en: 'Layout', ru: 'Раскладка' },
  'multi.emptyBody': { fr: 'Le multi-écran est vide.', en: 'Multi-view is empty.', ru: 'Мультиэкран пуст.' },
  'multi.browse': { fr: 'Choisir des chaînes', en: 'Pick channels', ru: 'Выбрать каналы' },
  'common.close': { fr: 'Fermer', en: 'Close', ru: 'Закрыть' },
  // Programme TV (EPG grid page)
  'programme.title': { fr: 'Programme TV', en: 'TV guide', ru: 'Телепрограмма' },
  'programme.empty': { fr: 'Pas de guide pour ce pays.', en: 'No guide for this country.', ru: 'Нет программы для этой страны.' },
  'programme.allCountries': { fr: 'Tous les pays', en: 'All countries', ru: 'Все страны' },
  'programme.allCategories': { fr: 'Toutes catégories', en: 'All categories', ru: 'Все категории' },
  'home.surprise': { fr: 'Surprenez-moi', en: 'Surprise me', ru: 'Удиви меня' },
  // Films (public-domain VOD)
  'films.title': { fr: 'Films', en: 'Movies', ru: 'Фильмы' },
  'films.search': { fr: 'Rechercher un film…', en: 'Search a movie…', ru: 'Поиск фильма…' },
  'films.empty': { fr: 'Aucun film pour cette recherche.', en: 'No movie for this search.', ru: 'Фильмы не найдены.' },
  'films.unavailable': { fr: 'Les films sont indisponibles pour le moment.', en: 'Movies are unavailable right now.', ru: 'Фильмы сейчас недоступны.' },
  'films.note': { fr: 'Domaine public via Internet Archive', en: 'Public domain via Internet Archive', ru: 'Общественное достояние, Internet Archive' },
  // Footer
  'footer.tagline': { fr: 'La télé en direct du monde entier, depuis des flux libres.', en: 'Live TV from around the world, from freely available streams.', ru: 'Прямой эфир со всего мира из открытых источников.' },
  'footer.explore': { fr: 'EXPLORER', en: 'EXPLORE', ru: 'ОБЗОР' },
  'footer.account': { fr: 'COMPTE', en: 'ACCOUNT', ru: 'АККАУНТ' },
  'footer.legal': { fr: 'LÉGAL', en: 'LEGAL', ru: 'ПРАВО' },
  'footer.liveNow': { fr: 'En direct', en: 'Live now', ru: 'В эфире' },
  'footer.programmeTv': { fr: 'Programme TV', en: 'TV guide', ru: 'Телепрограмма' },
  'footer.favorites': { fr: 'Favoris', en: 'Favorites', ru: 'Избранное' },
  'footer.installApp': { fr: "Installer l'app", en: 'Install the app', ru: 'Установить приложение' },
  'footer.terms': { fr: 'Conditions', en: 'Terms', ru: 'Условия' },
  'footer.privacy': { fr: 'Confidentialité', en: 'Privacy', ru: 'Конфиденциальность' },
  'footer.source': { fr: 'Source iptv-org', en: 'iptv-org source', ru: 'Источник iptv-org' },
  // Pricing
  'pricing.description': { fr: 'Toutes les chaînes restent gratuites. Premium ajoute du confort.', en: 'Every channel stays free. Premium adds comfort.', ru: 'Все каналы остаются бесплатными. Премиум добавляет удобство.' },
  // Install modal
  'install.title': { en: 'Install NEOWATCH', fr: 'Installer NEOWATCH', ru: 'Установить NEOWATCH' },
  'install.phone': { fr: 'Téléphone / tablette', en: 'Phone / tablet', ru: 'Телефон / планшет' },
  'install.phoneBody': { en: 'Open the link, then add it to your home screen.', fr: 'Ouvrez le lien, puis ajoutez-le à l’écran d’accueil.', ru: 'Откройте ссылку и добавьте её на главный экран.' },
  'install.tv': { fr: 'Android TV / Smart TV', en: 'Android TV / Smart TV', ru: 'Android TV / Smart TV' },
  'install.tvBody': { en: 'Open the TV browser and go to this address. The remote works.', fr: 'Ouvrez le navigateur de la TV et allez à cette adresse. La télécommande fonctionne.', ru: 'Откройте браузер ТВ и перейдите по адресу. Пульт работает.' },
  'install.pc': { fr: 'Ordinateur', en: 'Computer', ru: 'Компьютер' },
  'install.pcBody': { en: 'Use Install in the address bar of Chrome or Edge.', fr: 'Utilisez Installer dans la barre d’adresse de Chrome ou Edge.', ru: 'Нажмите «Установить» в адресной строке Chrome или Edge.' },
  // Preferences (premium)
  'prefs.catAll': { fr: 'Catégorie : toutes', en: 'Category: all', ru: 'Категория: все' },
  'prefs.countryAll': { fr: 'Pays : tous', en: 'Country: all', ru: 'Страна: все' },
  'prefs.langAll': { fr: 'Langue : toutes', en: 'Language: all', ru: 'Язык: все' },
  'prefs.pin': { fr: 'Épingler', en: 'Pin', ru: 'Закрепить' },
  'prefs.show': { fr: 'Afficher', en: 'Show', ru: 'Показать' },
  'prefs.hide': { fr: 'Masquer', en: 'Hide', ru: 'Скрыть' },
  // Channel detail page
  'detail.back': { fr: 'Retour', en: 'Back', ru: 'Назад' },
  'detail.notFound': { fr: 'Cette chaîne n’existe plus.', en: 'This channel is gone.', ru: 'Этого канала больше нет.' },
  'detail.share': { fr: 'Partager', en: 'Share', ru: 'Поделиться' },
  'detail.programme': { fr: 'Programme', en: 'Schedule', ru: 'Программа' },
  'detail.noProgramme': { fr: 'Programme non disponible pour cette chaîne.', en: 'No schedule available for this channel.', ru: 'Программа для этого канала недоступна.' },
  'detail.similar': { fr: 'Chaînes similaires', en: 'Similar channels', ru: 'Похожие каналы' },
  // Common
  // ── Lot 0 shared keys (DESIGN-SPEC sections 2 and 3). Lots add theirs in lib/i18n/<lot>.ts ──
  // Navigation (tabs, dock, avatar menu)
  'nav.live': { fr: 'TV en direct', en: 'Live TV', ru: 'Эфир' },
  'nav.guide': { fr: 'Guide TV', en: 'Guide', ru: 'Программа' },
  'nav.movies': { fr: 'Films', en: 'Movies', ru: 'Фильмы' },
  'nav.radio': { fr: 'Radio', en: 'Radio', ru: 'Радио' },
  'nav.multi': { fr: 'Multi-écran', en: 'Multi-view', ru: 'Мультиэкран' },
  'nav.search': { fr: 'Rechercher', en: 'Search', ru: 'Поиск' },
  'menu.myList': { fr: 'Ma liste', en: 'My list', ru: 'Мой список' },
  'menu.premium': { fr: 'Premium', en: 'Premium', ru: 'Премиум' },
  'menu.premiumOn': { fr: 'Premium · actif', en: 'Premium · active', ru: 'Премиум · активен' },
  'menu.install': { fr: 'Installer l’app', en: 'Install the app', ru: 'Установить приложение' },
  'menu.language': { fr: 'Langue', en: 'Language', ru: 'Язык' },
  'menu.settings': { fr: 'Réglages', en: 'Settings', ru: 'Настройки' },
  'menu.admin': { fr: 'Admin', en: 'Admin', ru: 'Админ' },
  'menu.signOut': { fr: 'Se déconnecter', en: 'Sign out', ru: 'Выйти' },
  // Status phrase (top bar)
  'top.status': { fr: '{n} en direct · liste de {time}', en: '{n} live · list from {time}', ru: '{n} в эфире · список от {time}' },
  'top.listOld': { fr: 'liste ancienne', en: 'list is old', ru: 'список устарел' },
  'top.offline': { fr: 'hors ligne', en: 'offline', ru: 'нет связи' },
  // Pills and overlines (mono caps are allowed here only)
  'pill.live': { fr: 'DIRECT', en: 'LIVE', ru: 'ЭФИР' },
  'pill.checking': { fr: 'VÉRIFICATION', en: 'CHECKING', ru: 'ПРОВЕРКА' },
  'pill.offAir': { fr: 'HORS ANTENNE', en: 'OFF AIR', ru: 'НЕ В ЭФИРЕ' },
  'pill.blocked': { fr: 'PEUT ÊTRE BLOQUÉE', en: 'MAY BE BLOCKED', ru: 'МОЖЕТ БЫТЬ ЗАКРЫТ' },
  'pill.premium': { fr: 'PREMIUM', en: 'PREMIUM', ru: 'ПРЕМИУМ' },
  'pill.currentPlan': { fr: 'OFFRE ACTUELLE', en: 'CURRENT PLAN', ru: 'ТЕКУЩИЙ ТАРИФ' },
  'pill.onNow': { fr: 'EN COURS', en: 'ON NOW', ru: 'СЕЙЧАС' },
  'pill.tip': { fr: 'ASTUCE', en: 'TIP', ru: 'СОВЕТ' },
  'pill.signIn': { fr: 'CONNEXION', en: 'SIGN IN', ru: 'ВХОД' },
  // Honest states: every number has its age
  'meta.notChecked': { fr: 'non vérifiée', en: 'not checked', ru: 'не проверено' },
  'meta.checked': { fr: 'vérifiée {age}', en: 'checked {age}', ru: 'проверено {age}' },
  'age.now': { fr: 'à l’instant', en: 'just now', ru: 'только что' },
  'age.min': { fr: 'il y a {n} min', en: '{n} min ago', ru: '{n} мин назад' },
  'age.h': { fr: 'il y a {n} h', en: '{n} h ago', ru: '{n} ч назад' },
  'age.d': { fr: 'il y a {n} j', en: '{n} d ago', ru: '{n} дн. назад' },
  // Counts: t.n('count.channels', n) picks .one/.few/.many/.other (Intl.PluralRules)
  'count.channels.one': { fr: '{n} chaîne', en: '{n} channel', ru: '{n} канал' },
  'count.channels.few': { fr: '{n} chaînes', en: '{n} channels', ru: '{n} канала' },
  'count.channels.many': { fr: '{n} chaînes', en: '{n} channels', ru: '{n} каналов' },
  'count.channels.other': { fr: '{n} chaînes', en: '{n} channels', ru: '{n} канала' },
  'count.stations.one': { fr: '{n} radio', en: '{n} station', ru: '{n} станция' },
  'count.stations.few': { fr: '{n} radios', en: '{n} stations', ru: '{n} станции' },
  'count.stations.many': { fr: '{n} radios', en: '{n} stations', ru: '{n} станций' },
  'count.stations.other': { fr: '{n} radios', en: '{n} stations', ru: '{n} станции' },
  'count.categories.one': { fr: '{n} catégorie', en: '{n} category', ru: '{n} категория' },
  'count.categories.few': { fr: '{n} catégories', en: '{n} categories', ru: '{n} категории' },
  'count.categories.many': { fr: '{n} catégories', en: '{n} categories', ru: '{n} категорий' },
  'count.categories.other': { fr: '{n} catégories', en: '{n} categories', ru: '{n} категории' },
  // Hero, rows, cards
  'hero.until': { fr: '{title}, jusqu’à {time}.', en: '{title}, until {time}.', ru: '{title}, до {time}.' },
  'hero.liveFrom': { fr: 'En direct de {country}.', en: 'Live from {country}.', ru: 'Прямой эфир: {country}.' },
  'row.pickedNow': { fr: 'choisies maintenant', en: 'picked now', ru: 'подобрано сейчас' },
  'card.nextAt': { fr: 'Ensuite à {time} : {title}', en: 'Next at {time}: {title}', ru: 'Далее в {time}: {title}' },
  // Player chrome
  'player.close': { fr: 'Fermer', en: 'Close', ru: 'Закрыть' },
  'player.channelPage': { fr: 'Page de la chaîne', en: 'Channel page', ru: 'Страница канала' },
  'player.nextChannel': { fr: 'Chaîne suivante', en: 'Next channel', ru: 'Следующий канал' },
  'player.untilTime': { fr: '{title} · jusqu’à {time}', en: '{title} · until {time}', ru: '{title} · до {time}' },
  'player.nextTime': { fr: 'Ensuite {time} : {title}', en: 'Next {time}: {title}', ru: 'Далее {time}: {title}' },
  // Toasts (one sentence, at most 8 words)
  'toast.undo': { fr: 'Annuler', en: 'Undo', ru: 'Отменить' },
  'toast.addedList': { fr: 'Ajoutée à ma liste.', en: 'Added to my list.', ru: 'Добавлено в мой список.' },
  'toast.removedList': { fr: 'Retirée de ma liste.', en: 'Removed from my list.', ru: 'Удалено из списка.' },
  'toast.addedMulti': { fr: 'Ajoutée au multi-écran · {n} sur {max}', en: 'Added to multi-view · {n} of {max}', ru: 'Добавлено в мультиэкран · {n} из {max}' },
  'toast.copied': { fr: 'Lien copié.', en: 'Link copied.', ru: 'Ссылка скопирована.' },
  'toast.premiumOn': { fr: 'Premium est actif.', en: 'Premium is on.', ru: 'Премиум включён.' },
  'toast.backExit': { fr: 'Appuyez encore sur Retour pour quitter', en: 'Press Back again to exit', ru: 'Нажмите «Назад» ещё раз, чтобы выйти' },
  // Empty states: one per page, one action (spec 2.9)
  'empty.clearSearch': { fr: 'Effacer la recherche', en: 'Clear search', ru: 'Очистить поиск' },
  'empty.browseChannels': { fr: 'Parcourir les chaînes', en: 'Browse channels', ru: 'Смотреть каналы' },
  'empty.allCountries': { fr: 'Voir tous les pays', en: 'Show all countries', ru: 'Все страны' },
  'empty.tryAgain': { fr: 'Réessayer', en: 'Try again', ru: 'Повторить' },
  'empty.backToChannels': { fr: 'Retour aux chaînes', en: 'Back to channels', ru: 'К каналам' },
  // Search and filters
  'search.resultsFor': { fr: 'Résultats pour « {q} »', en: 'Results for “{q}”', ru: 'Результаты для «{q}»' },
  'search.onAirNow': { fr: 'À l’antenne', en: 'On air now', ru: 'Сейчас в эфире' },
  'filter.checkAgain': { fr: 'Vérifier à nouveau', en: 'Check again', ru: 'Проверить снова' },
  // Pricing (spec 2.7)
  'pricing.overline': { fr: 'NEOWATCH PREMIUM', en: 'NEOWATCH PREMIUM', ru: 'NEOWATCH ПРЕМИУМ' },
  'pricing.start': { fr: 'Activer Premium', en: 'Start Premium', ru: 'Подключить Премиум' },
  'pricing.signInToStart': { en: 'Sign in first', fr: 'Se connecter', ru: 'Сначала войти' },
  'pricing.isOn': { fr: 'Premium actif', en: 'Premium is on', ru: 'Премиум активен' },
  'pricing.footer': { fr: 'Résiliable à tout moment. Vous payez le service, pas les flux.', en: 'Cancel anytime. You pay for the service, not the streams.', ru: 'Отмена в любой момент. Вы платите за сервис, а не за каналы.' },
  // Sign-in (spec 2.8)
  'login.tvTitle': { fr: 'Connectez-vous avec votre téléphone', en: 'Sign in with your phone', ru: 'Войдите через телефон' },
  'login.orOpen': { fr: 'ou ouvrez {url}', en: 'or open {url}', ru: 'или откройте {url}' },
  'login.waitingPhone': { fr: 'En attente du téléphone · code valable {n} min', en: 'Waiting for your phone · code valid {n} min', ru: 'Ждём телефон · код действует {n} мин' },
  'login.useEmail': { fr: 'Utiliser l’e-mail', en: 'Use email instead', ru: 'Войти по почте' },
  'login.wrong': { fr: 'E-mail ou mot de passe incorrect.', en: 'Wrong email or password.', ru: 'Неверная почта или пароль.' },
  'link.connectTv': { fr: 'Connecter cette TV', en: 'Connect this TV', ru: 'Подключить этот ТВ' },
  'link.connected': { fr: 'TV connectée. Regardez votre TV.', en: 'TV connected. Look at your TV.', ru: 'ТВ подключён. Посмотрите на экран.' },
  // Install (spec 4.6)
  'install.ios': { fr: 'Touchez Partager, puis Sur l’écran d’accueil.', en: 'Tap Share, then Add to Home Screen.', ru: 'Нажмите «Поделиться», затем «На экран Домой».' },
  // Settings (spec 1.4, Lot C)
  'set.lunaire': { fr: 'Lunaire', en: 'Lunar', ru: 'Лунный' },
  'set.doux': { fr: 'Doux', en: 'Soft', ru: 'Мягкий' },
  'detail.docTitle': { fr: '{name} · en direct sur NEOWATCH', en: '{name} · live on NEOWATCH', ru: '{name} · в эфире на NEOWATCH' },
  // Category labels (format.ts categoryLabel). Unknown ids fall back to the id.
  'cat.sports': { fr: 'Sport', en: 'Sport', ru: 'Спорт' },
  'cat.foot': { fr: 'Foot', en: 'Football', ru: 'Футбол' },
  'cat.news': { fr: 'Actualités', en: 'News', ru: 'Новости' },
  'cat.movies': { fr: 'Films', en: 'Movies', ru: 'Фильмы' },
  'cat.series': { fr: 'Séries', en: 'Series', ru: 'Сериалы' },
  'cat.entertainment': { fr: 'Divertissement', en: 'Entertainment', ru: 'Развлечения' },
  'cat.kids': { fr: 'Enfants', en: 'Kids', ru: 'Детям' },
  'cat.music': { fr: 'Musique', en: 'Music', ru: 'Музыка' },
  'cat.documentary': { fr: 'Documentaires', en: 'Documentary', ru: 'Документальные' },
  'cat.general': { fr: 'Généralistes', en: 'General', ru: 'Общие' },
  'cat.culture': { fr: 'Culture', en: 'Culture', ru: 'Культура' },
  'cat.comedy': { fr: 'Comédie', en: 'Comedy', ru: 'Юмор' },
  'cat.cooking': { fr: 'Cuisine', en: 'Cooking', ru: 'Кулинария' },
  'cat.lifestyle': { fr: 'Art de vivre', en: 'Lifestyle', ru: 'Стиль жизни' },
  'cat.business': { fr: 'Économie', en: 'Business', ru: 'Бизнес' },
  'cat.science': { fr: 'Sciences', en: 'Science', ru: 'Наука' },
  'cat.education': { fr: 'Éducation', en: 'Education', ru: 'Образование' },
  'cat.religious': { fr: 'Religion', en: 'Religion', ru: 'Религия' },
  'cat.travel': { fr: 'Voyage', en: 'Travel', ru: 'Путешествия' },
  'cat.weather': { fr: 'Météo', en: 'Weather', ru: 'Погода' },
  'cat.animation': { fr: 'Animation', en: 'Animation', ru: 'Анимация' },
  'cat.family': { fr: 'Famille', en: 'Family', ru: 'Семья' },
  'cat.legislative': { fr: 'Politique', en: 'Politics', ru: 'Политика' },
  'cat.outdoor': { fr: 'Plein air', en: 'Outdoor', ru: 'На природе' },
  'cat.auto': { fr: 'Auto-moto', en: 'Cars', ru: 'Авто' },
  'cat.shop': { fr: 'Shopping', en: 'Shopping', ru: 'Покупки' },
  'cat.relax': { fr: 'Détente', en: 'Relax', ru: 'Релакс' },
  'cat.classic': { fr: 'Classiques', en: 'Classics', ru: 'Классика' },
  'cat.public': { fr: 'Service public', en: 'Public', ru: 'Общественные' },
  'cat.interactive': { fr: 'Interactif', en: 'Interactive', ru: 'Интерактив' },
  'cat.undefined': { fr: 'Autres', en: 'Other', ru: 'Другое' },
} satisfies Dict;

const MERGED = { ...CORE, ...home, ...shell, ...pages, ...logic };

/** Every known key (CORE + fragments). `t()` also accepts any string (dev warning when unknown). */
export type TKey = keyof typeof MERGED;
type KeyArg = TKey | (string & {});
/** Interpolation values for `{name}` placeholders. Numbers are formatted with fmtNum() (pass a string for a year or an id). */
export type Vars = Record<string, string | number>;

const DICT: Dict = MERGED;

const isLang = (v: unknown): v is Lang => v === 'fr' || v === 'en' || v === 'ru';

if (import.meta.env.DEV) {
  // Two fragments defining the same key is a merge accident: say so.
  const seen = new Map<string, string>();
  for (const [name, frag] of Object.entries({ home, shell, pages, logic } as Record<string, Dict>)) {
    for (const k of Object.keys(frag)) {
      const prev = seen.get(k);
      if (prev) console.warn(`[i18n] key "${k}" is defined in both ${prev}.ts and ${name}.ts`);
      seen.set(k, name);
    }
  }
}

/** First of navigator.languages that is fr / ru / en; English otherwise. */
export function detectLang(): Lang {
  if (typeof navigator === 'undefined') return 'en';
  const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const l of list) {
    const p = String(l || '').toLowerCase().slice(0, 2);
    if (isLang(p)) return p;
  }
  return 'en';
}

interface I18nState {
  lang: Lang;
  setLang: (l: Lang) => void;
}
export const useI18n = create<I18nState>()(
  persist((set) => ({ lang: detectLang(), setLang: (lang) => set({ lang: isLang(lang) ? lang : 'en' }) }), {
    name: 'neowatch.lang',
    partialize: (s) => ({ lang: s.lang }),
    // A stored value that is not a known language is ignored (detection wins).
    merge: (persisted, current) => {
      const l = (persisted as { lang?: unknown } | undefined)?.lang;
      return { ...current, lang: isLang(l) ? l : current.lang };
    },
  })
);

export function currentLang(): Lang {
  return useI18n.getState().lang;
}

// ── verify instrumentation (test/verify-design.mjs sets window.__NW_VERIFY) ──
type VerifyWindow = Window & { __NW_VERIFY?: unknown; __nwT?: Set<string>; __nwDict?: Dict };
const vw: VerifyWindow | null = typeof window !== 'undefined' ? (window as VerifyWindow) : null;
const verifying = !!vw?.__NW_VERIFY;
if (verifying && vw) {
  vw.__nwT = vw.__nwT || new Set<string>();
  vw.__nwDict = DICT;
}

const warned = new Set<string>();
function missing(key: string) {
  if (import.meta.env.DEV && !warned.has(key)) {
    warned.add(key);
    console.warn(`[i18n] missing key "${key}"`);
  }
}

// ── formatting in the current UI language ──
const numFmt = new Map<string, Intl.NumberFormat>();
/** 8510 -> "8,510" (en) / "8 510" (fr, ru). */
export function fmtNum(n: number, lang: Lang = currentLang()): string {
  if (!Number.isFinite(n)) return String(n);
  let f = numFmt.get(lang);
  if (!f) numFmt.set(lang, (f = new Intl.NumberFormat(LOCALES[lang])));
  return f.format(n);
}

const timeFmt = new Map<string, Intl.DateTimeFormat>();
/** Local HH:MM (24 h) for a timestamp in ms, a Date or an ISO string. */
export function fmtTime(at: number | string | Date, lang: Lang = currentLang()): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  let f = timeFmt.get(lang);
  if (!f) timeFmt.set(lang, (f = new Intl.DateTimeFormat(LOCALES[lang], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })));
  return f.format(d);
}

/** Short date ("8 Oct") in the UI language; `opts` overrides the format. */
export function fmtDate(at: number | string | Date, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }, lang: Lang = currentLang()): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(LOCALES[lang], opts).format(d);
}

const plural = new Map<string, Intl.PluralRules>();
function pluralRule(n: number, lang: Lang): string {
  let p = plural.get(lang);
  if (!p) plural.set(lang, (p = new Intl.PluralRules(LOCALES[lang])));
  return p.select(n);
}

/** Translate `key` in `lang`, replacing `{name}` placeholders. */
export function translate(lang: Lang, key: KeyArg, vars?: Vars): string {
  const e = DICT[key as string];
  let s = e ? e[lang] ?? e.en : undefined;
  if (s === undefined) {
    missing(key as string);
    s = key as string;
  }
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, name: string) => {
      const v = vars[name];
      if (v === undefined) return m;
      return typeof v === 'number' ? fmtNum(v, lang) : v;
    });
  }
  if (verifying && vw?.__nwT) vw.__nwT.add(s.trim());
  return s;
}

/** Plural form: looks up `${base}.${rule}` (one / few / many / other), then `${base}.other`. `{n}` is set for you. */
export function translatePlural(lang: Lang, base: string, n: number, vars?: Vars): string {
  const rule = pluralRule(n, lang);
  const key = DICT[`${base}.${rule}`] ? `${base}.${rule}` : `${base}.other`;
  return translate(lang, key, { n, ...vars });
}

/** "just now" / "2 min ago" / "3 h ago" / "2 d ago" for a past timestamp in ms. */
export function fmtAge(at: number, now = Date.now(), lang: Lang = currentLang()): string {
  const min = Math.max(0, Math.floor((now - at) / 60000));
  if (min < 1) return translate(lang, 'age.now');
  if (min < 60) return translate(lang, 'age.min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 48) return translate(lang, 'age.h', { n: h });
  return translate(lang, 'age.d', { n: Math.floor(h / 24) });
}

/** The translator returned by useT(): `t(key, vars?)`, plus `t.n(base, n, vars?)` for counts and `t.lang`. */
export type TFn = ((key: KeyArg, vars?: Vars) => string) & {
  n: (base: string, n: number, vars?: Vars) => string;
  lang: Lang;
};

function makeT(lang: Lang): TFn {
  const fn = ((key: KeyArg, vars?: Vars) => translate(lang, key, vars)) as TFn;
  fn.n = (base, n, vars) => translatePlural(lang, base, n, vars);
  fn.lang = lang;
  return fn;
}
const tCache = new Map<Lang, TFn>();
function tFor(lang: Lang): TFn {
  let f = tCache.get(lang);
  if (!f) tCache.set(lang, (f = makeT(lang)));
  return f;
}

/** Reactive translator hook (re-renders on language change). Usage: `const t = useT(); t('home.watch')`. */
export function useT(): TFn {
  const lang = useI18n((s) => s.lang);
  return tFor(lang);
}

/** Non-hook translator for stores, libs and event handlers (reads the current language). */
export function t(key: KeyArg, vars?: Vars): string {
  return translate(currentLang(), key, vars);
}
t.n = (base: string, n: number, vars?: Vars) => translatePlural(currentLang(), base, n, vars);

/** True when the key exists (for optional server-provided keys such as `titleKey`). */
export function hasKey(key: string): boolean {
  return !!DICT[key];
}

// Set <html lang> for accessibility/SEO.
export function applyLang() {
  if (typeof document !== 'undefined') document.documentElement.lang = useI18n.getState().lang;
}
useI18n.subscribe(applyLang);
