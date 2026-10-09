import type { Dict } from '../i18n';

// i18n fragment for Lot B (TopBar, AvatarMenu, Dock, PromoStrip, AdBanner, App,
// Player, MultiView, Install, spatialNav). EN, FR and RU on every key, one key
// per line. Rules: at most 12 words per sentence, buttons verb first (at most 3
// words), caps only in pills / overlines, no jargon, no em dash.
export const shell = {
  // Top bar, dock, avatar menu
  'shell.home': { en: 'Home', fr: 'Accueil', ru: 'Главная' },
  'shell.mainNav': { en: 'Main', fr: 'Principal', ru: 'Основное' },
  'shell.menu': { en: 'Menu', fr: 'Menu', ru: 'Меню' },
  'shell.menuFor': { en: 'Menu for {name}', fr: 'Menu de {name}', ru: 'Меню: {name}' },
  'shell.signedOut': { en: 'You are signed out.', fr: 'Vous êtes déconnecté.', ru: 'Вы вышли.' },
  // App shell
  'shell.crashTitle': { en: 'Something went wrong', fr: 'Un problème est survenu', ru: 'Что-то пошло не так' },
  'shell.crashBody': { en: 'Reload the page to start again.', fr: 'Rechargez la page pour recommencer.', ru: 'Перезагрузите страницу, чтобы начать снова.' },
  'shell.reload': { en: 'Reload', fr: 'Recharger', ru: 'Перезагрузить' },
  'shell.notFoundTitle': { en: 'Page not found', fr: 'Page introuvable', ru: 'Страница не найдена' },
  'shell.notFoundBody': { en: 'This address leads nowhere. The channels are still here.', fr: 'Cette adresse ne mène nulle part. Les chaînes sont toujours là.', ru: 'Этот адрес никуда не ведёт. Каналы на месте.' },
  // Player
  'shell.prevChannel': { en: 'Previous channel', fr: 'Chaîne précédente', ru: 'Предыдущий канал' },
  'shell.inMulti': { en: 'In multi-view', fr: 'Dans le multi-écran', ru: 'В мультиэкране' },
  'shell.audioSubs': { en: 'Audio and subtitles', fr: 'Audio et sous-titres', ru: 'Звук и субтитры' },
  'shell.qualityAuto': { en: 'Automatic', fr: 'Automatique', ru: 'Автоматически' },
  'shell.qualityLevel': { en: 'Level {n}', fr: 'Niveau {n}', ru: 'Уровень {n}' },
  'shell.trackN': { en: 'Track {n}', fr: 'Piste {n}', ru: 'Дорожка {n}' },
  // Multi-view
  // Plural base: t.n('shell.tilesOf', n, { max })
  'shell.tilesOf.one': { en: '{n} of {max} screens', fr: '{n} écran sur {max}', ru: '{n} из {max} экранов' },
  'shell.tilesOf.other': { en: '{n} of {max} screens', fr: '{n} écrans sur {max}', ru: '{n} из {max} экранов' },
  'shell.multiHint': { en: 'Pick a screen to hear it.', fr: 'Choisissez un écran pour l’écouter.', ru: 'Выберите экран, чтобы его слушать.' },
  'shell.multiEmptyHow': { en: 'Add channels with the + button in the player.', fr: 'Ajoutez des chaînes avec le bouton + du lecteur.', ru: 'Добавляйте каналы кнопкой + в плеере.' },
  'shell.tileLabel': { en: '{name}: play its sound', fr: '{name} : écouter le son', ru: '{name}: включить звук' },
  'shell.soundOn': { en: 'Sound', fr: 'Son', ru: 'Звук' },
  'shell.soundBlocked': { en: 'Tap for sound', fr: 'Touchez pour le son', ru: 'Нажмите для звука' },
  'shell.multiCleared': { en: 'Multi-view cleared.', fr: 'Multi-écran vidé.', ru: 'Мультиэкран очищен.' },
  'shell.tileRemoved': { en: '{name} removed.', fr: '{name} retirée.', ru: '{name}: убрано.' },
  // Install (spec 4.6)
  'shell.installHere': { en: 'Add NEOWATCH to this device, like an app.', fr: 'Ajoutez NEOWATCH à cet appareil, comme une app.', ru: 'Добавьте NEOWATCH на это устройство как приложение.' },
  'shell.installNow': { en: 'Install the app', fr: 'Installer l’app', ru: 'Установить' },
  'shell.installed': { en: 'NEOWATCH is installed.', fr: 'NEOWATCH est installée.', ru: 'NEOWATCH установлен.' },
  'shell.alreadyInstalled': { en: 'NEOWATCH is already installed here.', fr: 'NEOWATCH est déjà installée ici.', ru: 'NEOWATCH уже установлен здесь.' },
  'shell.scanToOpen': { en: 'Scan with a phone to open NEOWATCH there.', fr: 'Scannez avec un téléphone pour y ouvrir NEOWATCH.', ru: 'Отсканируйте телефоном, чтобы открыть NEOWATCH.' },
  'shell.copyLink': { en: 'Copy the link', fr: 'Copier le lien', ru: 'Скопировать ссылку' },
  'shell.qrAlt': { en: 'QR code to open NEOWATCH', fr: 'QR code pour ouvrir NEOWATCH', ru: 'QR-код для открытия NEOWATCH' },
  'shell.getTvApp': { en: 'Get the TV app', fr: 'Obtenir l’app TV', ru: 'Скачать ТВ-приложение' },
  // Core keys rewritten to the tone rules (folded back by the integrator)
  'pill.unavailable': { en: 'UNAVAILABLE', fr: 'INDISPONIBLE', ru: 'НЕДОСТУПЕН' },
  'pill.film': { en: 'MOVIE', fr: 'FILM', ru: 'ФИЛЬМ' },
  'ads.consentBody': { en: 'Free access is paid for by ads. They use cookies.', fr: 'Les pubs financent l’accès gratuit. Elles utilisent des cookies.', ru: 'Бесплатный доступ оплачивает реклама. Она использует cookie.' },
  'ads.accept': { en: 'Allow ads', fr: 'Accepter les pubs', ru: 'Разрешить рекламу' },
  'ads.decline': { en: 'No thanks', fr: 'Non merci', ru: 'Нет, спасибо' },
} satisfies Dict;
