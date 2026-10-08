import type { Dict } from '../i18n';

// i18n fragment for Lot D (sw, api, stores, fresh, HlsVideo, epg).
// EN, FR and RU complete. At most 12 words per sentence, buttons verb first
// (at most 3 words), caps only in pills/overlines, no jargon, no em dash.
export const logic = {
  // authStore fallbacks (the server message is shown when there is one)
  'auth.loginFailed': { en: 'Sign-in failed. Try again.', fr: 'Connexion impossible. Réessayez.', ru: 'Не удалось войти. Попробуйте снова.' },
  'auth.registerFailed': { en: 'Sign-up failed. Try again.', fr: 'Inscription impossible. Réessayez.', ru: 'Не удалось зарегистрироваться. Попробуйте снова.' },
  // catalogStore: the grid could not load (Lot A renders it with a Retry action)
  'catalog.unavailable': { en: 'Channels are unavailable right now.', fr: 'Les chaînes sont indisponibles pour le moment.', ru: 'Каналы сейчас недоступны.' },
  // HlsVideo
  'player.removed': { en: 'This channel was removed.', fr: 'Cette chaîne a été retirée.', ru: 'Этот канал удалён.' },
  'player.removedHint': { en: 'It is no longer available here.', fr: 'Elle n’est plus disponible ici.', ru: 'Он здесь больше недоступен.' },
  'player.unsupported': { en: 'This device cannot play this channel.', fr: 'Cet appareil ne peut pas lire cette chaîne.', ru: 'Это устройство не может показать канал.' },
  'player.unsupportedHint': { en: 'Try it on another screen.', fr: 'Essayez sur un autre écran.', ru: 'Попробуйте на другом экране.' },
  'player.soundOn': { en: 'Turn sound on', fr: 'Activer le son', ru: 'Включить звук' },
  'player.tapToPlay': { en: 'Start watching', fr: 'Lancer la lecture', ru: 'Начать просмотр' },
} satisfies Dict;
