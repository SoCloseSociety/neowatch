import { api } from './api';
import { useI18n } from './i18n';

// 24h locale per UI language so EPG times match the viewer's expectations.
const TIME_LOCALE: Record<string, string> = { fr: 'fr-FR', en: 'en-GB', ru: 'ru-RU' };

export interface Programme {
  start: number;
  stop: number | null;
  title: string;
  desc?: string | null;
}
export interface NowNext {
  now: Programme | null;
  next: Programme | null;
}
export interface ProgrammeResult {
  channelId: string;
  channel: { id: string; name: string; logo?: string; flag?: string; tier?: 'free' | 'premium' };
  title: string;
  start: number;
  stop: number | null;
  live: boolean;
}

export async function fetchNowNext(ids: string[]): Promise<Record<string, NowNext>> {
  if (!ids.length) return {};
  try {
    const r = await api.get<{ channels: Record<string, NowNext> }>(`/epg/now?ids=${encodeURIComponent(ids.join(','))}`);
    return r.channels || {};
  } catch {
    return {};
  }
}

export async function searchProgrammes(q: string): Promise<ProgrammeResult[]> {
  if (!q.trim()) return [];
  try {
    const r = await api.get<{ results: ProgrammeResult[] }>(`/epg/search?q=${encodeURIComponent(q)}`);
    return r.results || [];
  } catch {
    return [];
  }
}

export function fmtTime(ms: number): string {
  try {
    const locale = TIME_LOCALE[useI18n.getState().lang] || 'fr-FR';
    return new Date(ms).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
