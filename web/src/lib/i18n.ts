import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Lang = 'fr' | 'en' | 'ru';

export const LANGS: { code: Lang; label: string; flag: string }[] = [
  { code: 'fr', label: 'Français', flag: '🇫🇷' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
];

// UI string dictionary. Keys are dot-namespaced; every key has fr/en/ru.
type Tr = Record<Lang, string>;
const DICT: Record<string, Tr> = {
  // TopBar
  'search.placeholder': { fr: 'Rechercher une chaîne, un match, une émission…', en: 'Search a channel, a match, a show…', ru: 'Поиск канала, матча, передачи…' },
  'search.clear': { fr: 'Effacer', en: 'Clear', ru: 'Очистить' },
  'search.recent': { fr: 'Recherches récentes', en: 'Recent searches', ru: 'Недавние запросы' },
  'top.online': { fr: 'EN LIGNE', en: 'ONLINE', ru: 'В ЭФИРЕ' },
  'top.premium': { fr: 'Premium', en: 'Premium', ru: 'Премиум' },
  'top.install': { fr: 'Installer', en: 'Install', ru: 'Установить' },
  'top.installTv': { fr: 'Installer (TV / mobile)', en: 'Install (TV / mobile)', ru: 'Установить (ТВ / моб.)' },
  'top.settings': { fr: 'Réglages', en: 'Settings', ru: 'Настройки' },
  'top.multi': { fr: 'Multi-écran', en: 'Multi-view', ru: 'Мультиэкран' },
  'top.login': { fr: 'Connexion', en: 'Sign in', ru: 'Войти' },
  'top.account': { fr: 'Mon compte', en: 'My account', ru: 'Мой аккаунт' },
  'top.admin': { fr: 'Admin', en: 'Admin', ru: 'Админ' },
  // Promo strip
  'promo.offer': { fr: 'OFFRE', en: 'OFFER', ru: 'АКЦИЯ' },
  'promo.tip': { fr: 'ASTUCE', en: 'TIP', ru: 'СОВЕТ' },
  'promo.premiumMsg': { fr: 'Premium : sans publicité, multi-écran étendu, vos playlists & sync', en: 'Premium: ad-free, extended multi-view, your playlists & sync', ru: 'Премиум: без рекламы, расширенный мультиэкран, ваши плейлисты и синхронизация' },
  'promo.installMsg': { fr: 'Installez NEOWATCH sur votre TV, mobile et ordinateur', en: 'Install NEOWATCH on your TV, phone and computer', ru: 'Установите NEOWATCH на ТВ, телефон и компьютер' },
  'promo.discover': { fr: 'Découvrir', en: 'Discover', ru: 'Подробнее' },
  // Home
  'home.live': { fr: 'En direct', en: 'Live', ru: 'В эфире' },
  'home.heroTitle1': { fr: 'Le direct,', en: 'Live TV,', ru: 'Прямой эфир,' },
  'home.heroTitle2': { fr: 'sans limite', en: 'unlimited', ru: 'без границ' },
  'home.heroTagline': { fr: 'Sport & foot, news, films, séries, musique, enfants… des milliers de chaînes du monde entier, en un clic.', en: 'Sport & football, news, movies, series, music, kids… thousands of channels worldwide, one click away.', ru: 'Спорт и футбол, новости, фильмы, сериалы, музыка, дети… тысячи каналов со всего мира в один клик.' },
  'home.watch': { fr: 'Regarder', en: 'Watch', ru: 'Смотреть' },
  'home.myList': { fr: 'Ma liste', en: 'My list', ru: 'Мой список' },
  'home.inMyList': { fr: 'Dans ma liste', en: 'In my list', ru: 'В списке' },
  'home.browseCategories': { fr: 'Parcourir par catégorie', en: 'Browse by category', ru: 'По категориям' },
  'home.liveNow': { fr: 'En direct maintenant', en: 'Live now', ru: 'Сейчас в эфире' },
  'home.favorites': { fr: 'Mes favoris', en: 'My favorites', ru: 'Избранное' },
  'home.resume': { fr: 'Reprendre', en: 'Resume', ru: 'Продолжить' },
  'home.seeAll': { fr: 'Tout voir', en: 'See all', ru: 'Все' },
  'home.channelsCount': { fr: 'chaînes', en: 'channels', ru: 'каналов' },
  'home.freeBannerTitle': { fr: 'Vous regardez avec la formule gratuite', en: "You're watching on the free plan", ru: 'Вы смотрите на бесплатном тарифе' },
  'home.freeBannerSub': { fr: 'Tout le catalogue est déjà gratuit. Passez Premium pour retirer la publicité, le multi-écran étendu, vos playlists M3U et la synchronisation.', en: 'The whole catalog is already free. Go Premium to remove ads, get extended multi-view, your M3U playlists and sync.', ru: 'Весь каталог уже бесплатен. Премиум убирает рекламу и добавляет расширенный мультиэкран, ваши плейлисты M3U и синхронизацию.' },
  'home.goPremium': { fr: 'Passer Premium', en: 'Go Premium', ru: 'Перейти на Премиум' },
  // FilterBar
  'filter.allCategories': { fr: 'Toutes catégories', en: 'All categories', ru: 'Все категории' },
  'filter.allCountries': { fr: 'Tous pays', en: 'All countries', ru: 'Все страны' },
  'filter.allLanguages': { fr: 'Toutes langues', en: 'All languages', ru: 'Все языки' },
  'filter.online': { fr: 'En ligne', en: 'Online', ru: 'В эфире' },
  'filter.noGeo': { fr: 'Sans géo-bloc', en: 'No geo-block', ru: 'Без геоблока' },
  'filter.check': { fr: 'Vérifier', en: 'Check', ru: 'Проверить' },
  'filter.sortSmart': { fr: 'Tri : pertinence', en: 'Sort: relevance', ru: 'Сорт.: релевантность' },
  'filter.sortName': { fr: 'Tri : A→Z', en: 'Sort: A→Z', ru: 'Сорт.: А→Я' },
  'filter.sortLatency': { fr: 'Tri : plus rapides', en: 'Sort: fastest', ru: 'Сорт.: быстрые' },
  'filter.allChannels': { fr: 'Toutes les chaînes', en: 'All channels', ru: 'Все каналы' },
  // Settings
  'set.title': { fr: 'Apparence & lecture', en: 'Appearance & playback', ru: 'Вид и воспроизведение' },
  'set.language': { fr: 'Langue', en: 'Language', ru: 'Язык' },
  'set.accent': { fr: "Couleur d'accent", en: 'Accent color', ru: 'Акцентный цвет' },
  'set.theme': { fr: 'Thème de fond', en: 'Background theme', ru: 'Тема фона' },
  'set.density': { fr: 'Densité de la grille', en: 'Grid density', ru: 'Плотность сетки' },
  'set.playback': { fr: 'Lecture', en: 'Playback', ru: 'Воспроизведение' },
  'set.defaultMuted': { fr: 'Couper le son par défaut', en: 'Muted by default', ru: 'Без звука по умолчанию' },
  'set.autoplay': { fr: 'Lecture auto', en: 'Autoplay', ru: 'Автовоспроизведение' },
  'set.preferProxy': { fr: 'Toujours passer par le proxy', en: 'Always use the proxy', ru: 'Всегда через прокси' },
  'set.preferProxyHint': { fr: 'Utile sur réseaux qui bloquent les flux', en: 'Useful on networks that block streams', ru: 'Полезно в сетях, блокирующих потоки' },
  'set.showOffline': { fr: 'Afficher les chaînes hors-ligne', en: 'Show offline channels', ru: 'Показывать оффлайн-каналы' },
  'set.reduceMotion': { fr: 'Réduire les animations', en: 'Reduce motion', ru: 'Меньше анимаций' },
  // Player
  'player.interrupted': { fr: 'Lecture interrompue', en: 'Playback interrupted', ru: 'Воспроизведение прервано' },
  'player.retry': { fr: 'Réessayer', en: 'Retry', ru: 'Повторить' },
  'player.forceProxy': { fr: 'Forcer le proxy', en: 'Force proxy', ru: 'Через прокси' },
  'player.connecting': { fr: 'Connexion…', en: 'Connecting…', ru: 'Подключение…' },
  'player.viaProxy': { fr: 'Connexion via le proxy…', en: 'Connecting via proxy…', ru: 'Подключение через прокси…' },
  'player.retrying': { fr: 'Nouvelle tentative…', en: 'Retrying…', ru: 'Повторная попытка…' },
  'player.buffering': { fr: 'Mise en mémoire tampon…', en: 'Buffering…', ru: 'Буферизация…' },
  'player.audioTrack': { fr: 'Audio', en: 'Audio', ru: 'Аудио' },
  'player.subtitles': { fr: 'Sous-titres', en: 'Subtitles', ru: 'Субтитры' },
  'player.off': { fr: 'Désactivés', en: 'Off', ru: 'Выкл.' },
  // Home misc
  'home.adLabel': { fr: 'PUBLICITÉ', en: 'AD', ru: 'РЕКЛАМА' },
  'home.loading': { fr: 'Catalogue en cours de chargement…', en: 'Loading the catalog…', ru: 'Загрузка каталога…' },
  'home.heroClip': { fr: 'des milliers de chaînes en un clic.', en: 'thousands of channels, one click away.', ru: 'тысячи каналов в один клик.' },
  'home.international': { fr: 'International', en: 'International', ru: 'Международные' },
  // QR / device pairing (sign in a TV by scanning with the phone)
  'qr.connectPhone': { fr: 'Se connecter avec mon téléphone', en: 'Sign in with my phone', ru: 'Войти с телефона' },
  'qr.title': { fr: 'Connexion par QR', en: 'Sign in by QR', ru: 'Вход по QR' },
  'qr.scan': { fr: 'Scanne ce QR avec ton téléphone déjà connecté à NEOWATCH.', en: 'Scan this QR with your phone already signed in to NEOWATCH.', ru: 'Отсканируйте QR телефоном, где вы уже вошли в NEOWATCH.' },
  'qr.orCode': { fr: 'Ou va sur neowatch.soclose.co/link et entre le code :', en: 'Or go to neowatch.soclose.co/link and enter the code:', ru: 'Или откройте neowatch.soclose.co/link и введите код:' },
  'qr.waiting': { fr: 'En attente de confirmation sur le téléphone…', en: 'Waiting for confirmation on your phone…', ru: 'Ожидание подтверждения на телефоне…' },
  'qr.expired': { fr: 'Code expiré.', en: 'Code expired.', ru: 'Код истёк.' },
  'qr.retry': { fr: 'Nouveau code', en: 'New code', ru: 'Новый код' },
  'qr.back': { fr: 'Retour', en: 'Back', ru: 'Назад' },
  // Phone-side approval page (/link)
  'link.title': { fr: 'Connecter une TV', en: 'Connect a TV', ru: 'Подключить ТВ' },
  'link.prompt': { fr: 'Connecter cette TV à ton compte NEOWATCH ?', en: 'Connect this TV to your NEOWATCH account?', ru: 'Подключить этот ТВ к вашему аккаунту NEOWATCH?' },
  'link.confirm': { fr: 'Oui, connecter la TV', en: 'Yes, connect the TV', ru: 'Да, подключить ТВ' },
  'link.needLogin': { fr: 'Connecte-toi d’abord, puis reviens scanner.', en: 'Sign in first, then scan again.', ru: 'Сначала войдите, затем сканируйте снова.' },
  'link.signin': { fr: 'Se connecter', en: 'Sign in', ru: 'Войти' },
  'link.done': { fr: 'TV connectée ! Reviens à ta télé.', en: 'TV connected! Head back to your TV.', ru: 'ТВ подключён! Вернитесь к телевизору.' },
  'link.invalid': { fr: 'Code invalide ou expiré.', en: 'Code invalid or expired.', ru: 'Код неверен или истёк.' },
  'link.noCode': { fr: 'Aucun code fourni.', en: 'No code provided.', ru: 'Код не указан.' },
  // Player controls & status
  'player.errorHint': { fr: 'Flux peut-être géo-bloqué, hors-ligne ou momentanément indisponible. Essayez une relance, le proxy, ou une autre chaîne.', en: 'The stream may be geo-blocked, offline or temporarily unavailable. Try again, force the proxy, or pick another channel.', ru: 'Поток может быть заблокирован по региону, офлайн или временно недоступен. Повторите, включите прокси или выберите другой канал.' },
  'player.play': { fr: 'Lecture (Espace)', en: 'Play (Space)', ru: 'Воспроизвести (пробел)' },
  'player.pause': { fr: 'Pause (Espace)', en: 'Pause (Space)', ru: 'Пауза (пробел)' },
  'player.mute': { fr: 'Couper le son (M)', en: 'Mute (M)', ru: 'Без звука (M)' },
  'player.quality': { fr: 'Qualité', en: 'Quality', ru: 'Качество' },
  'player.pip': { fr: 'Picture-in-picture', en: 'Picture-in-picture', ru: 'Картинка в картинке' },
  'player.fullscreen': { fr: 'Plein écran (F)', en: 'Fullscreen (F)', ru: 'Во весь экран (F)' },
  'player.live': { fr: 'EN DIRECT', en: 'LIVE', ru: 'ПРЯМОЙ ЭФИР' },
  'player.loading': { fr: 'CHARGEMENT', en: 'LOADING', ru: 'ЗАГРУЗКА' },
  'player.error': { fr: 'ERREUR', en: 'ERROR', ru: 'ОШИБКА' },
  'player.onNow': { fr: 'EN COURS', en: 'ON NOW', ru: 'СЕЙЧАС' },
  'player.nextUp': { fr: 'Ensuite', en: 'Next', ru: 'Далее' },
  'player.proxyTitle': { fr: 'Forcer le proxy (réseaux bloqués)', en: 'Force the proxy (blocked networks)', ru: 'Через прокси (для заблокированных сетей)' },
  'player.volume': { fr: 'Volume', en: 'Volume', ru: 'Громкость' },
  // Shared card / control actions
  'common.favorite': { fr: 'Favori', en: 'Favorite', ru: 'Избранное' },
  'common.addMulti': { fr: 'Ajouter au multi-écran', en: 'Add to multi-view', ru: 'В мультиэкран' },
  'common.info': { fr: 'Infos & programme', en: 'Info & guide', ru: 'Инфо и программа' },
  'common.prev': { fr: 'Précédent', en: 'Previous', ru: 'Назад' },
  'common.next': { fr: 'Suivant', en: 'Next', ru: 'Вперёд' },
  // Grid empty states
  'grid.noFav': { fr: 'Aucun favori pour l’instant', en: 'No favorites yet', ru: 'Пока нет избранного' },
  'grid.noFavHint': { fr: 'Ajoutez des chaînes avec le cœur pour les retrouver ici.', en: 'Add channels with the heart to find them here.', ru: 'Добавляйте каналы сердечком, чтобы видеть их здесь.' },
  'grid.noMatch': { fr: 'Aucune chaîne ne correspond', en: 'No channels match', ru: 'Ничего не найдено' },
  'grid.noMatchHint': { fr: 'Élargissez la recherche ou changez de filtres.', en: 'Broaden the search or change the filters.', ru: 'Расширьте поиск или измените фильтры.' },
  // Auth gate + login form
  'gate.body': { fr: 'Connectez-vous pour accéder à toutes les chaînes en direct.', en: 'Sign in to access all live channels.', ru: 'Войдите, чтобы смотреть все каналы в прямом эфире.' },
  'login.title': { fr: 'Connexion NEOWATCH', en: 'NEOWATCH sign-in', ru: 'Вход в NEOWATCH' },
  'login.name': { fr: 'Nom (optionnel)', en: 'Name (optional)', ru: 'Имя (необязательно)' },
  'login.email': { fr: 'Email', en: 'Email', ru: 'Эл. почта' },
  'login.password': { fr: 'Mot de passe', en: 'Password', ru: 'Пароль' },
  'login.showPw': { fr: 'Afficher', en: 'Show', ru: 'Показать' },
  'login.hidePw': { fr: 'Masquer', en: 'Hide', ru: 'Скрыть' },
  'login.signIn': { fr: 'Se connecter', en: 'Sign in', ru: 'Войти' },
  'login.create': { fr: 'Créer mon compte', en: 'Create my account', ru: 'Создать аккаунт' },
  'login.noAccount': { fr: 'Pas encore de compte ?', en: 'No account yet?', ru: 'Ещё нет аккаунта?' },
  'login.register': { fr: 'Inscrivez-vous', en: 'Sign up', ru: 'Зарегистрируйтесь' },
  'login.tagline': { fr: 'Gratuit · sport & films en Premium', en: 'Free · sport & movies with Premium', ru: 'Бесплатно · спорт и фильмы в Premium' },
  'login.welcomeBack': { fr: 'Content de vous revoir', en: 'Good to see you again', ru: 'Рады видеть вас снова' },
  'login.welcomeNew': { fr: 'Des milliers de chaînes en direct vous attendent', en: 'Thousands of live channels are waiting for you', ru: 'Тысячи каналов в прямом эфире ждут вас' },
  'login.tabLogin': { fr: 'Connexion', en: 'Sign in', ru: 'Вход' },
  'login.tabRegister': { fr: 'Créer un compte', en: 'Create account', ru: 'Создать аккаунт' },
  // Account panel
  'account.email': { fr: 'Email', en: 'Email', ru: 'Эл. почта' },
  'account.role': { fr: 'Rôle', en: 'Role', ru: 'Роль' },
  'account.plan': { fr: 'Abonnement', en: 'Plan', ru: 'Подписка' },
  'account.free': { fr: 'Gratuit', en: 'Free', ru: 'Бесплатный' },
  'account.expires': { fr: 'Expire le', en: 'Expires on', ru: 'Действует до' },
  'account.cancel': { fr: 'Résilier le Premium', en: 'Cancel Premium', ru: 'Отменить Premium' },
  'account.upgrade': { fr: 'Passer Premium', en: 'Go Premium', ru: 'Перейти на Premium' },
  'account.password': { fr: 'Mot de passe', en: 'Password', ru: 'Пароль' },
  'account.currentPw': { fr: 'Mot de passe actuel', en: 'Current password', ru: 'Текущий пароль' },
  'account.newPw': { fr: 'Nouveau (min 6)', en: 'New (min 6)', ru: 'Новый (мин. 6)' },
  'account.update': { fr: 'Mettre à jour', en: 'Update', ru: 'Обновить' },
  'account.logout': { fr: 'Se déconnecter', en: 'Sign out', ru: 'Выйти' },
  'account.prefs': { fr: 'Préférences d’affichage', en: 'Viewing preferences', ru: 'Настройки отображения' },
  'account.delete': { fr: 'Supprimer mon compte', en: 'Delete my account', ru: 'Удалить аккаунт' },
  'account.deleteWarn': { fr: 'Suppression définitive : compte, favoris et configuration seront effacés immédiatement.', en: 'Permanent deletion: account, favorites and configuration are erased immediately.', ru: 'Безвозвратное удаление: аккаунт, избранное и настройки будут стёрты немедленно.' },
  'account.deleteConfirm': { fr: 'Supprimer définitivement', en: 'Delete permanently', ru: 'Удалить навсегда' },
  // Programme search strip
  'progsearch.onAir': { fr: 'À l’antenne · émissions', en: 'On air · shows', ru: 'В эфире · передачи' },
  // Internet radio
  'radio.title': { fr: 'Radios', en: 'Radio', ru: 'Радио' },
  'radio.subtitle': { fr: 'Les radios du monde entier, en direct -- annuaire communautaire radio-browser.', en: 'Live radio from around the world -- community radio-browser directory.', ru: 'Радиостанции со всего мира в прямом эфире -- каталог radio-browser.' },
  'radio.search': { fr: 'Rechercher une radio, un pays, un genre…', en: 'Search a station, a country, a genre…', ru: 'Поиск станции, страны, жанра…' },
  'radio.empty': { fr: 'Aucune radio trouvée.', en: 'No stations found.', ru: 'Станции не найдены.' },
  'radio.playing': { fr: 'En écoute', en: 'Now playing', ru: 'Сейчас играет' },
  'radio.connecting': { fr: 'Connexion…', en: 'Connecting…', ru: 'Подключение…' },
  'radio.error': { fr: 'Flux indisponible -- essayez une autre radio.', en: 'Stream unavailable -- try another station.', ru: 'Поток недоступен -- попробуйте другую станцию.' },
  'radio.stop': { fr: 'Arrêter', en: 'Stop', ru: 'Стоп' },
  // Multi-view
  'multi.focus': { fr: 'Focus', en: 'Focus', ru: 'Фокус' },
  'multi.mosaic': { fr: 'Mosaïque', en: 'Mosaic', ru: 'Мозаика' },
  'multi.title': { fr: 'Multi-écran', en: 'Multi-view', ru: 'Мультиэкран' },
  'multi.hint': { fr: 'Touchez une vignette pour écouter son son. Idéal pour suivre plusieurs matchs.', en: 'Tap a tile to hear its audio. Great for following several matches.', ru: 'Нажмите на плитку, чтобы слушать её звук. Удобно для нескольких матчей.' },
  'multi.clear': { fr: 'Vider', en: 'Clear', ru: 'Очистить' },
  'multi.audio': { fr: 'Activer le son', en: 'Use this audio', ru: 'Включить звук' },
  'multi.remove': { fr: 'Retirer', en: 'Remove', ru: 'Убрать' },
  'multi.layout': { fr: 'Disposition', en: 'Layout', ru: 'Раскладка' },
  'multi.emptyBody': { fr: 'Aucune chaîne pour l’instant. Ouvrez une chaîne, puis ajoutez-la au multi-écran pour suivre plusieurs flux en même temps (jusqu’à 9).', en: 'No channels yet. Open a channel, then add it to multi-view to watch several streams at once (up to 9).', ru: 'Пока нет каналов. Откройте канал и добавьте его в мультиэкран, чтобы смотреть несколько потоков сразу (до 9).' },
  'multi.browse': { fr: 'Parcourir les chaînes', en: 'Browse channels', ru: 'Смотреть каналы' },
  'common.close': { fr: 'Fermer', en: 'Close', ru: 'Закрыть' },
  // Programme TV (EPG grid page)
  'programme.title': { fr: 'Programme TV', en: 'TV guide', ru: 'Телепрограмма' },
  'programme.subtitle': { fr: 'La grille des programmes en direct', en: 'Live schedule grid', ru: 'Сетка передач в эфире' },
  'programme.empty': { fr: 'Aucun programme disponible pour ce filtre.', en: 'No guide available for this filter.', ru: 'Нет программы для этого фильтра.' },
  'programme.allCountries': { fr: 'Tous les pays', en: 'All countries', ru: 'Все страны' },
  'programme.allCategories': { fr: 'Toutes catégories', en: 'All categories', ru: 'Все категории' },
  'programme.now': { fr: 'Maintenant', en: 'Now', ru: 'Сейчас' },
  'home.surprise': { fr: 'Surprends-moi', en: 'Surprise me', ru: 'Удиви меня' },
  // Films (public-domain VOD)
  'films.title': { fr: 'Films', en: 'Movies', ru: 'Фильмы' },
  'films.subtitle': { fr: 'Classiques & cultes du domaine public, en accès libre', en: 'Public-domain classics & cult films, free to watch', ru: 'Классика и культовое кино из общественного достояния' },
  'films.search': { fr: 'Rechercher un film…', en: 'Search a movie…', ru: 'Поиск фильма…' },
  'films.empty': { fr: 'Aucun film pour cette recherche.', en: 'No movie for this search.', ru: 'Фильмы не найдены.' },
  'films.unavailable': { fr: 'Catalogue de films indisponible pour le moment.', en: 'Movie catalog unavailable right now.', ru: 'Каталог фильмов сейчас недоступен.' },
  'films.note': { fr: 'Domaine public via Internet Archive', en: 'Public domain via Internet Archive', ru: 'Общественное достояние, Internet Archive' },
  // Footer
  'footer.tagline': { fr: 'Le direct, sans limite. Des milliers de chaînes du monde entier, agrégées depuis des flux librement accessibles.', en: 'Live TV, unlimited. Thousands of channels worldwide, aggregated from freely available streams.', ru: 'Прямой эфир без границ. Тысячи каналов со всего мира из открытых источников.' },
  'footer.explore': { fr: 'EXPLORER', en: 'EXPLORE', ru: 'ОБЗОР' },
  'footer.account': { fr: 'COMPTE', en: 'ACCOUNT', ru: 'АККАУНТ' },
  'footer.legal': { fr: 'LÉGAL', en: 'LEGAL', ru: 'ПРАВО' },
  'footer.liveNow': { fr: 'En direct', en: 'Live now', ru: 'В эфире' },
  'footer.programmeTv': { fr: 'Programme TV', en: 'TV guide', ru: 'Телепрограмма' },
  'footer.favorites': { fr: 'Favoris', en: 'Favorites', ru: 'Избранное' },
  'footer.importPlaylist': { fr: 'Importer une playlist', en: 'Import a playlist', ru: 'Импорт плейлиста' },
  'footer.installApp': { fr: "Installer l'app", en: 'Install the app', ru: 'Установить приложение' },
  'footer.terms': { fr: 'Conditions', en: 'Terms', ru: 'Условия' },
  'footer.privacy': { fr: 'Confidentialité', en: 'Privacy', ru: 'Конфиденциальность' },
  'footer.source': { fr: 'Source iptv-org', en: 'iptv-org source', ru: 'Источник iptv-org' },
  // Pricing
  'pricing.description': { fr: "Toutes les chaînes sont gratuites. Premium améliore le confort : sans publicité, multi-écran étendu, sync, vos playlists IPTV et l'EPG personnalisé.", en: 'Every channel is free. Premium upgrades the experience: no ads, extended multi-view, sync, your IPTV playlists and a personalized EPG.', ru: 'Все каналы бесплатны. Премиум улучшает удобство: без рекламы, расширенный мультиэкран, синхронизация, ваши IPTV-плейлисты и телепрограмма.' },
  // Install modal
  'install.title': { fr: 'Installer sur TV, mobile & ordi', en: 'Install on TV, phone & computer', ru: 'Установить на ТВ, телефон и ПК' },
  'install.phone': { fr: 'Téléphone / tablette', en: 'Phone / tablet', ru: 'Телефон / планшет' },
  'install.phoneBody': { fr: "Scannez le QR (ou ouvrez le lien), puis « Ajouter à l'écran d'accueil » dans le menu du navigateur -> lancement instantané, plein écran.", en: 'Scan the QR (or open the link), then "Add to Home Screen" in the browser menu -> instant, full-screen launch.', ru: 'Отсканируйте QR (или откройте ссылку), затем «На главный экран» в меню браузера -> мгновенный полноэкранный запуск.' },
  'install.tv': { fr: 'Android TV / Smart TV', en: 'Android TV / Smart TV', ru: 'Android TV / Smart TV' },
  'install.tvBody': { fr: 'Ouvrez le navigateur de la TV et allez sur le lien. Navigation à la télécommande (D-pad) intégrée. Épinglez la page pour un accès direct.', en: 'Open the TV browser and go to the link. Remote (D-pad) navigation is built in. Pin the page for direct access.', ru: 'Откройте браузер ТВ и перейдите по ссылке. Навигация пультом (D-pad) встроена. Закрепите страницу для быстрого доступа.' },
  'install.pc': { fr: 'Ordinateur', en: 'Computer', ru: 'Компьютер' },
  'install.pcBody': { fr: "Cliquez sur l'icône Installer dans la barre du navigateur (Chrome/Edge) pour l'app dédiée.", en: 'Click the Install icon in the browser bar (Chrome/Edge) for the dedicated app.', ru: 'Нажмите значок «Установить» в строке браузера (Chrome/Edge) для отдельного приложения.' },
  // Preferences (premium)
  'prefs.title': { fr: 'Mes préférences de visionnage', en: 'My viewing preferences', ru: 'Мои предпочтения просмотра' },
  'prefs.upsellBody': { fr: "Personnalisez et optimisez le catalogue selon vos besoins : masquez les catégories inutiles, épinglez vos préférées, définissez votre page d'accueil.", en: 'Tailor and optimize the catalog to your needs: hide categories you never watch, pin your favorites, set your home page.', ru: 'Настройте каталог под себя: скройте ненужные категории, закрепите любимые, задайте домашнюю страницу.' },
  'prefs.unlock': { fr: 'Débloquer avec Premium', en: 'Unlock with Premium', ru: 'Открыть с Премиум' },
  'prefs.homeDefault': { fr: "Page d'accueil par défaut", en: 'Default home page', ru: 'Домашняя страница по умолчанию' },
  'prefs.catAll': { fr: 'Catégorie : toutes', en: 'Category: all', ru: 'Категория: все' },
  'prefs.countryAll': { fr: 'Pays : tous', en: 'Country: all', ru: 'Страна: все' },
  'prefs.langAll': { fr: 'Langue : toutes', en: 'Language: all', ru: 'Язык: все' },
  'prefs.curate': { fr: 'Catégories : épingler / masquer', en: 'Categories: pin / hide', ru: 'Категории: закрепить / скрыть' },
  'prefs.pin': { fr: 'Épingler', en: 'Pin', ru: 'Закрепить' },
  'prefs.show': { fr: 'Afficher', en: 'Show', ru: 'Показать' },
  'prefs.hide': { fr: 'Masquer', en: 'Hide', ru: 'Скрыть' },
  // Channel detail page
  'detail.back': { fr: 'Retour', en: 'Back', ru: 'Назад' },
  'detail.notFound': { fr: 'Chaîne introuvable.', en: 'Channel not found.', ru: 'Канал не найден.' },
  'detail.share': { fr: 'Partager', en: 'Share', ru: 'Поделиться' },
  'detail.programme': { fr: 'Programme', en: 'Schedule', ru: 'Программа' },
  'detail.onNow': { fr: 'EN COURS', en: 'ON NOW', ru: 'СЕЙЧАС' },
  'detail.noProgramme': { fr: 'Programme non disponible pour cette chaîne.', en: 'No schedule available for this channel.', ru: 'Программа для этого канала недоступна.' },
  'detail.similar': { fr: 'Chaînes similaires', en: 'Similar channels', ru: 'Похожие каналы' },
  'detail.info': { fr: 'Infos & programme', en: 'Info & schedule', ru: 'Инфо и программа' },
  // Common
  'common.premium': { fr: 'Premium', en: 'Premium', ru: 'Премиум' },
};

interface I18nState {
  lang: Lang;
  setLang: (l: Lang) => void;
}
export const useI18n = create<I18nState>()(
  persist((set) => ({ lang: 'fr', setLang: (lang) => set({ lang }) }), { name: 'neowatch.lang' })
);

// Reactive translator hook. Usage: const t = useT(); t('home.watch')
export function useT() {
  const lang = useI18n((s) => s.lang);
  return (key: string) => DICT[key]?.[lang] ?? DICT[key]?.fr ?? key;
}

// Set <html lang> for accessibility/SEO.
export function applyLang() {
  if (typeof document !== 'undefined') document.documentElement.lang = useI18n.getState().lang;
}
useI18n.subscribe(applyLang);
