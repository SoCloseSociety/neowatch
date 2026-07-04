export type StreamKind = 'hls' | 'youtube' | 'dash' | 'other';

export interface Channel {
  id: string;
  channelId: string | null;
  name: string;
  url: string;
  kind: StreamKind;
  quality: string | null;
  label: string | null; // "Geo-blocked" | "Not 24/7" | ...
  userAgent: string | null;
  referrer: string | null;
  logo?: string;
  categories: string[];
  categoryNames: string[];
  country: string | null;
  countryName: string | null;
  flag: string | null;
  languages: string[];
  languageNames: string[];
  website: string | null;
  nsfw: boolean;
  tier?: 'free' | 'premium';
  locked?: boolean; // premium channel, hidden URL for non-premium users
  source?: 'iptv-org' | 'custom';
  proxyUrl?: string | null; // server-signed proxy URL (only for playable items)
  alternates?: { url: string; proxyUrl: string | null; userAgent?: string | null; referrer?: string | null }[];
  online?: boolean | null;  // server-known reachability (sweep / on-demand)
  latency?: number | null;
}

export interface Facet {
  id: string;
  name: string;
  count: number;
}
export interface CountryFacet {
  code: string;
  name: string;
  flag: string;
  count: number;
}
export interface LangFacet {
  code: string;
  name: string;
  count: number;
}

export interface CatalogMeta {
  total: number;
  online?: number; // live count from the health sweep (for the "X online" pill)
  updatedAt: number;
  categories: Facet[];
  countries: CountryFacet[];
  languages: LangFacet[];
}

export interface ChannelPage {
  total: number;
  page: number;
  limit: number;
  pages: number;
  items: Channel[];
}

export type HealthStatus = 'unknown' | 'checking' | 'online' | 'offline';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  plan: 'free' | 'premium';
  planExpires: number | null;
  premium: boolean;
  createdAt: string;
  favorites: string[];
  multi?: Channel[]; // multi-screen mosaic config, roams across devices
}

export interface BillingConfig {
  provider: 'mock' | 'stripe';
  price: number;
  currency: string;
  period: number;
}

export interface RuntimeConfig {
  requireAuth: boolean;
  allowRegister: boolean;
  hideNsfw: boolean;
  name: string;
  epgEnabled?: boolean;
  billing?: BillingConfig;
  adsenseClient?: string;
  premiumCategories?: string[];
}

export interface Plan {
  id: 'free' | 'premium';
  name: string;
  price: number;
  currency: string;
  period: string;
  ads: boolean;
  features: string[];
}

export interface HomeRail {
  key: string;
  title: string;
  icon: string;
  filter: Partial<Filters>;
  total: number;
  channels: Channel[];
}
export interface HomeData {
  rails: HomeRail[];
  featured: (Channel & { railKey: string; railTitle: string; railIcon: string })[];
}

export interface Filters {
  category: string | null;
  country: string | null;
  language: string | null;
  q: string;
  foot: boolean;
  favoritesOnly: boolean;
  onlineOnly: boolean;
  hideGeoBlocked: boolean;
  sort: 'smart' | 'name' | 'latency';
}
