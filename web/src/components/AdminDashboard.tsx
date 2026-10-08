import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { ArrowLeft, RefreshCw, Trash2, ShieldCheck, Ban, Crown, Plus, Undo2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/store/authStore';
import { useCatalog } from '@/store/catalogStore';
import { toast } from '@/store/uiStore';
import { useT, fmtNum, fmtDate, fmtAge, type TFn } from '@/lib/i18n';
import { categoryLabel } from '@/lib/format';
import type { User } from '@/types';
import { Button, Overline, Pill, Spinner } from './ui';

interface Source {
  id: string;
  name: string;
  url: string | null;
  count: number;
  lastError: string | null;
  lastFetched: number | null;
}
interface EpgSource {
  id: string;
  name: string;
  url: string;
  count: number;
  lastError: string | null;
}
interface ConfigAudit { billingProvider: string; stripeConfigured: boolean; adsenseConfigured: boolean; jwtSecretExplicit: boolean; warnings: { level: string; key: string; msg: string }[] }
interface ChannelAudit { total: number; online: number; offline: number; unchecked: number; byCategory: Record<string, { total: number; online: number; offline: number; unchecked: number }> }

const errText = (t: TFn, e: unknown) => (e instanceof ApiError && e.message ? e.message : t('pages.admin.failed'));

function Card({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-8 rounded-card border border-line bg-card p-[var(--pad-panneau)]">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-rangee font-semibold text-ink">{title}</h2>
          {hint && <p className="m-0 mt-1 text-sous text-ink-2">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ErrorLine({ text }: { text: string | null }) {
  if (!text) return null;
  return <p role="alert" className="m-0 mt-3 text-sous text-red">{text}</p>;
}

export function AdminDashboard() {
  const navigate = useNavigate();
  const t = useT();
  const { user, isAdmin } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', role: 'user' });
  const [err, setErr] = useState<string | null>(null);
  const [sweep, setSweep] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ users: User[] }>('/admin/users');
      setUsers(r.users);
    } catch (e) {
      setErr(errText(t, e));
    } finally {
      setLoading(false);
    }
  };
  // Run a mutation, surface its error, and reload the list.
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(errText(t, e));
    }
    load();
  };

  useEffect(() => {
    if (!user || !isAdmin()) {
      navigate('/');
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    await act(async () => {
      await api.post('/admin/users', form);
      setForm({ email: '', password: '', role: 'user' });
      toast(t('pages.admin.userCreated'), { ok: true });
    });
  };

  const patch = (id: string, body: Partial<User>) => act(() => api.patch(`/admin/users/${id}`, body));
  const remove = (u: User) => {
    if (!window.confirm(t('pages.admin.confirmDelete', { email: u.email }))) return;
    act(() => api.del(`/admin/users/${u.id}`));
  };
  const setUserPlan = (id: string, plan: 'free' | 'premium') => act(() => api.post(`/admin/users/${id}/plan`, { plan }));

  const refreshCatalog = async () => {
    setRefreshing(true);
    try {
      await api.post('/catalog/refresh');
      toast(t('pages.admin.refreshed'), { ok: true });
    } catch (e) {
      setErr(errText(t, e));
    } finally {
      setRefreshing(false);
    }
  };

  const runSweep = async () => {
    setSweep(t('pages.admin.sweepStarting'));
    try {
      const r = await api.post<{ started: boolean; checked: number; online: number; offline: number }>('/admin/health/sweep');
      setSweep(r.started ? t('pages.admin.sweepStarted', { checked: r.checked, online: r.online }) : t('pages.admin.sweepRunning'));
    } catch {
      setSweep(t('pages.admin.sweepDown'));
    }
  };

  const back = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/');
  };

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-[var(--gouttiere)] pb-16 pt-5">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <Button variant="quiet" iconOnly onClick={back} aria-label={t('detail.back')} title={t('detail.back')} icon={<ArrowLeft size={18} aria-hidden="true" />} />
          <div className="min-w-0 flex-1">
            <Overline>{t('menu.admin')}</Overline>
            <h1 className="m-0 text-titre font-semibold text-ink">{t('pages.admin.title')}</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={refreshCatalog} disabled={refreshing} icon={refreshing ? <Spinner className="h-4 w-4" /> : <RefreshCw size={16} aria-hidden="true" />}>
              {t('pages.admin.refresh')}
            </Button>
            <Button onClick={runSweep} title={t('pages.admin.sweepHint')}>{t('pages.admin.sweep')}</Button>
          </div>
        </div>
        {sweep && <p role="status" className="meta m-0 mt-2">{sweep}</p>}
        <ErrorLine text={err} />

        {/* Users */}
        <Card title={t('pages.admin.users')} hint={t('pages.admin.usersHint')}>
          <form onSubmit={createUser} className="mb-4 flex flex-wrap items-end gap-2">
            <input required type="email" placeholder={t('login.email')} aria-label={t('login.email')} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input min-w-[200px] flex-1" />
            <input required type="password" minLength={6} placeholder={t('pages.admin.password')} aria-label={t('pages.admin.password')} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="input min-w-[200px] flex-1" />
            <select aria-label={t('account.role')} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="input">
              <option value="user">{t('pages.admin.roleUser')}</option>
              <option value="admin">{t('pages.admin.roleAdmin')}</option>
            </select>
            <Button type="submit" icon={<Plus size={16} aria-hidden="true" />}>{t('pages.admin.create')}</Button>
          </form>

          <div className="overflow-x-auto rounded-field border border-line">
            <table className="w-full text-left text-sous">
              <thead className="bg-[var(--bg-2)]">
                <tr>
                  <th className="px-3 py-2 font-semibold text-ink-2">{t('account.email')}</th>
                  <th className="px-3 py-2 font-semibold text-ink-2">{t('account.role')}</th>
                  <th className="px-3 py-2 font-semibold text-ink-2">{t('account.plan')}</th>
                  <th className="px-3 py-2 text-right font-semibold text-ink-2">{t('pages.admin.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={4} className="px-3 py-8"><div className="flex justify-center"><Spinner /></div></td></tr>
                ) : (
                  users.map((u) => {
                    const expired = !u.premium && u.plan === 'premium';
                    return (
                      <tr key={u.id} className="border-t border-line">
                        <td className="px-3 py-2.5 text-ink">
                          <span translate="no">{u.email}</span>
                          {u.status !== 'active' && <Pill tone="alert" className="ml-2">{t('pages.admin.disabled')}</Pill>}
                        </td>
                        <td className="px-3 py-2.5 text-ink-2">{u.role === 'admin' ? t('pages.admin.roleAdmin') : t('pages.admin.roleUser')}</td>
                        <td className="px-3 py-2.5">
                          <span className="flex flex-wrap items-center gap-2">
                            {u.premium ? <Pill tone="ok">{t('pill.premium')}</Pill> : <span className="text-ink-2">{expired ? t('pages.admin.expired') : t('account.free')}</span>}
                            {u.role !== 'admin' && u.plan === 'premium' && u.planExpires && (
                              <span className="meta">
                                {u.premium ? t('pages.admin.until', { date: fmtDate(u.planExpires) }) : t('pages.admin.since', { date: fmtDate(u.planExpires) })}
                                {u.cancelAtPeriodEnd ? ` · ${t('pages.admin.cancelling')}` : ''}
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="quiet" iconOnly onClick={() => setUserPlan(u.id, u.premium ? 'free' : 'premium')} aria-label={u.premium ? t('pages.admin.removePremium') : t('pages.admin.givePremium')} title={u.premium ? t('pages.admin.removePremium') : t('pages.admin.givePremium')} icon={<Crown size={16} aria-hidden="true" />} />
                            <Button variant="quiet" iconOnly onClick={() => patch(u.id, { role: u.role === 'admin' ? 'user' : 'admin' })} aria-label={t('pages.admin.toggleAdmin')} title={t('pages.admin.toggleAdmin')} icon={<ShieldCheck size={16} aria-hidden="true" />} />
                            <Button variant="quiet" iconOnly onClick={() => patch(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })} aria-label={u.status === 'active' ? t('pages.admin.disable') : t('pages.admin.enable')} title={u.status === 'active' ? t('pages.admin.disable') : t('pages.admin.enable')} icon={<Ban size={16} aria-hidden="true" />} />
                            <Button variant="quiet" iconOnly onClick={() => remove(u)} disabled={u.id === user?.id} aria-label={t('pages.admin.delete')} title={t('pages.admin.delete')} icon={<Trash2 size={16} aria-hidden="true" />} />
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <AuditPanel />
        <Blocklist />
        <SourcesManager />
        <EpgManager />
      </div>
    </main>
  );
}

function AuditPanel() {
  const t = useT();
  const [cfg, setCfg] = useState<ConfigAudit | null>(null);
  const [ch, setCh] = useState<ChannelAudit | null>(null);
  const load = async () => {
    setCfg(await api.get<ConfigAudit>('/admin/config').catch(() => null));
    setCh(await api.get<ChannelAudit>('/admin/channels/audit').catch(() => null));
  };
  useEffect(() => { load(); }, []);

  const share = (n: number, total: number) => (total ? `${(n / total) * 100}%` : '0%');

  return (
    <Card
      title={t('pages.admin.audit')}
      action={<Button variant="quiet" iconOnly onClick={load} aria-label={t('pages.admin.reload')} title={t('pages.admin.reload')} icon={<RefreshCw size={16} aria-hidden="true" />} />}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="m-0 mb-2 text-libelle font-semibold text-ink-2">{t('pages.admin.config')}</h3>
          {cfg ? (
            <>
              <div className="mb-3 flex flex-wrap gap-2">
                <Pill tone={cfg.jwtSecretExplicit ? 'ok' : 'att'}>{t('pages.admin.secret')}</Pill>
                <Pill tone={cfg.billingProvider === 'stripe' ? (cfg.stripeConfigured ? 'ok' : 'att') : 'neutral'} data>{`${t('pages.admin.billing')} ${cfg.billingProvider}`}</Pill>
                <Pill tone={cfg.adsenseConfigured ? 'ok' : 'neutral'}>{t('pages.admin.ads')}</Pill>
              </div>
              {cfg.warnings.length === 0 ? (
                <p className="m-0 text-sous text-mint">{t('pages.admin.noIssue')}</p>
              ) : (
                <ul className="m-0 list-none space-y-1.5 p-0" translate="no">
                  {cfg.warnings.map((w, i) => (
                    <li key={i} className={clsx('text-sous', w.level === 'error' ? 'text-red' : w.level === 'warn' ? 'text-amber' : 'text-ink-2')}>
                      <span className="font-mono">{w.key}</span>: {w.msg}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : <Spinner />}
        </div>

        <div>
          <h3 className="m-0 mb-2 text-libelle font-semibold text-ink-2">{t('pages.admin.health')}</h3>
          {ch ? (
            <>
              <div className="mb-2 flex h-2 overflow-hidden rounded-pill bg-[var(--bg-3)]" aria-hidden="true">
                <span className="bg-mint" style={{ width: share(ch.online, ch.total) }} />
                <span className="bg-red" style={{ width: share(ch.offline, ch.total) }} />
              </div>
              <p className="m-0 text-sous text-ink-2">
                {t('pages.admin.healthLine', { online: ch.online, offline: ch.offline, unchecked: ch.unchecked })}
              </p>
              <ul className="m-0 mt-4 list-none space-y-1.5 p-0">
                {Object.entries(ch.byCategory)
                  .map(([k, v]) => ({ k, ...v }))
                  .sort((a, b) => b.total - a.total)
                  .slice(0, 12)
                  .map((c) => (
                    <li key={c.k} className="flex items-center gap-2">
                      <span className="w-28 shrink-0 truncate text-meta text-ink-2">{categoryLabel(c.k)}</span>
                      <span className="flex h-2 flex-1 overflow-hidden rounded-pill bg-[var(--bg-3)]" title={t('pages.admin.healthLine', { online: c.online, offline: c.offline, unchecked: c.unchecked })}>
                        <span className="bg-mint" style={{ width: share(c.online, c.total) }} />
                        <span className="bg-red" style={{ width: share(c.offline, c.total) }} />
                      </span>
                      <span className="meta w-14 shrink-0 text-right">{fmtNum(c.total)}</span>
                    </li>
                  ))}
              </ul>
            </>
          ) : <Spinner />}
        </div>
      </div>
    </Card>
  );
}

// Takedown blocklist: a stream listed here disappears from the catalog and the relay
// refuses it at once (GET/POST/DELETE /api/admin/blocklist).
function Blocklist() {
  const t = useT();
  const loadChannels = useCatalog((s) => s.loadChannels);
  const [urls, setUrls] = useState<string[] | null>(null);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.get<{ urls: string[] }>('/admin/blocklist');
      setUrls(r.urls || []);
    } catch (e) {
      setUrls([]);
      setError(errText(t, e));
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const list = [...new Set(text.split(/\s+/).map((x) => x.trim()).filter((x) => /^https?:\/\//i.test(x)))];
    if (!list.length) { setError(t('pages.admin.blockInvalid')); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ added: number; total: number }>('/admin/blocklist', { urls: list });
      setText('');
      toast(t('pages.admin.blockAdded', { n: r.added }), { ok: true });
      await load();
      loadChannels();
    } catch (e2) {
      setError(errText(t, e2));
    } finally {
      setBusy(false);
    }
  };

  const unblock = async (url: string) => {
    setError(null);
    try {
      await api.del('/admin/blocklist', { url });
      toast(t('pages.admin.unblocked'), { ok: true, undo: () => { api.post('/admin/blocklist', { urls: [url] }).then(load).catch(() => {}); } });
      await load();
      loadChannels();
    } catch (e) {
      setError(errText(t, e));
    }
  };

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (urls || []).filter((u) => !f || u.toLowerCase().includes(f));
  }, [urls, filter]);

  return (
    <Card title={t('pages.admin.blockTitle')} hint={t('pages.admin.blockHint')}>
      <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <textarea
          required
          rows={2}
          placeholder={t('pages.admin.blockPlaceholder')}
          aria-label={t('pages.admin.blockPlaceholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="input min-h-[var(--champ-h)] flex-1 font-mono"
        />
        <Button type="submit" variant="danger" disabled={busy} icon={busy ? <Spinner className="h-4 w-4" /> : <Ban size={16} aria-hidden="true" />}>
          {t('pages.admin.block')}
        </Button>
      </form>
      <ErrorLine text={error} />

      {urls === null ? (
        <div className="mt-4"><Spinner /></div>
      ) : urls.length === 0 ? (
        <p className="m-0 mt-4 text-sous text-ink-2">{t('pages.admin.blockEmpty')}</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <p className="meta m-0 flex-1">{t('pages.admin.blockCount', { n: urls.length })}</p>
            {urls.length > 8 && (
              <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('pages.admin.blockFilter')} aria-label={t('pages.admin.blockFilter')} className="input w-full sm:w-64" />
            )}
          </div>
          <ul className="m-0 mt-2 max-h-80 list-none space-y-1.5 overflow-y-auto p-0">
            {shown.map((u) => (
              <li key={u} className="flex items-center gap-2 rounded-field border border-line px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-meta text-ink-2" translate="no" title={u}>{u}</span>
                <Button variant="quiet" onClick={() => unblock(u)} icon={<Undo2 size={15} aria-hidden="true" />} aria-label={t('pages.admin.unblock')}>
                  {t('pages.admin.unblock')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function SourcesManager() {
  const t = useT();
  const loadMeta = useCatalog((s) => s.loadMeta);
  const loadChannels = useCatalog((s) => s.loadChannels);
  const [sources, setSources] = useState<Source[]>([]);
  const [mode, setMode] = useState<'url' | 'text'>('url');
  const [form, setForm] = useState({ name: '', url: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      // Admin route: carries url + lastError (the public /sources list does not).
      const r = await api.get<{ sources: Source[] }>('/admin/sources');
      setSources(r.sources);
    } catch (e) {
      setError(errText(t, e));
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshCatalog = async () => {
    await loadMeta();
    await loadChannels();
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'url' ? { name: form.name, url: form.url } : { name: form.name, text: form.text };
      const r = await api.post<{ sources: Source[] }>('/admin/sources', body);
      setSources(r.sources);
      setForm({ name: '', url: '', text: '' });
      toast(t('pages.admin.imported'), { ok: true });
      refreshCatalog();
    } catch (err) {
      setError(errText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const r = await api.del<{ sources: Source[] }>(`/admin/sources/${id}`).catch((e) => { setError(errText(t, e)); return null; });
    if (r) setSources(r.sources);
    refreshCatalog();
  };

  const refresh = async () => {
    setBusy(true);
    const r = await api.post<{ sources: Source[] }>('/admin/sources/refresh').catch((e) => { setError(errText(t, e)); return null; });
    if (r) setSources(r.sources);
    await refreshCatalog();
    setBusy(false);
  };

  return (
    <Card
      title={t('pages.admin.sources')}
      hint={t('pages.admin.sourcesHint')}
      action={sources.length > 0 ? (
        <Button variant="quiet" onClick={refresh} disabled={busy} icon={<RefreshCw size={16} className={clsx(busy && 'animate-spin')} aria-hidden="true" />}>{t('pages.admin.reload')}</Button>
      ) : undefined}
    >
      <form onSubmit={add}>
        <div role="tablist" className="mb-3 inline-grid grid-cols-2 gap-1 rounded-pill border border-line p-1">
          {(['url', 'text'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={clsx('min-h-[36px] rounded-pill px-4 text-sous', mode === m ? 'bg-[var(--bg-3)] font-semibold text-ink' : 'text-ink-2')}
            >
              {m === 'url' ? t('pages.admin.fromLink') : t('pages.admin.paste')}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <input required placeholder={t('pages.admin.sourceName')} aria-label={t('pages.admin.sourceName')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input sm:w-56" />
          {mode === 'url' ? (
            <input required type="url" placeholder="https://…/playlist.m3u" aria-label={t('pages.admin.link')} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="input flex-1" />
          ) : (
            <textarea required placeholder={'#EXTM3U\n#EXTINF:-1,…\nhttps://…'} aria-label={t('pages.admin.paste')} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} className="input min-h-[96px] flex-1 font-mono" />
          )}
          <Button type="submit" disabled={busy} icon={busy ? <Spinner className="h-4 w-4" /> : <Plus size={16} aria-hidden="true" />}>{t('pages.admin.import')}</Button>
        </div>
      </form>
      <ErrorLine text={error} />

      {sources.length > 0 && (
        <ul className="m-0 mt-4 list-none space-y-1.5 p-0">
          {sources.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-field border border-line px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sous text-ink" translate="no">{s.name}</div>
                <div className="truncate font-mono text-meta text-ink-3" translate="no">{s.url || t('pages.admin.pasted')}</div>
              </div>
              {s.lastError ? (
                <Pill tone="alert" data className="max-w-[40%] truncate">{s.lastError}</Pill>
              ) : (
                <span className="meta shrink-0">
                  {t.n('count.channels', s.count)}
                  {s.lastFetched ? ` · ${fmtAge(s.lastFetched)}` : ''}
                </span>
              )}
              <Button variant="quiet" iconOnly onClick={() => remove(s.id)} aria-label={t('pages.admin.delete')} title={t('pages.admin.delete')} icon={<Trash2 size={16} aria-hidden="true" />} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function EpgManager() {
  const t = useT();
  const [sources, setSources] = useState<EpgSource[]>([]);
  const [form, setForm] = useState({ name: '', url: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      // Admin route: carries url + lastError (the public /epg/sources list does not).
      const r = await api.get<{ sources: EpgSource[] }>('/admin/epg');
      setSources(r.sources);
    } catch (e) {
      setError(errText(t, e));
    }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ sources: EpgSource[] }>('/admin/epg', form);
      setSources(r.sources);
      setForm({ name: '', url: '' });
      toast(t('pages.admin.imported'), { ok: true });
    } catch (err) {
      setError(errText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await api.del(`/admin/epg/${id}`).catch((e) => setError(errText(t, e)));
    load();
  };

  return (
    <Card title={t('pages.admin.guide')} hint={t('pages.admin.guideHint')}>
      <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <input required placeholder={t('pages.admin.sourceName')} aria-label={t('pages.admin.sourceName')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input sm:w-56" />
        <input required type="url" placeholder="https://…/guide.xml.gz" aria-label={t('pages.admin.link')} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="input flex-1" />
        <Button type="submit" disabled={busy} icon={busy ? <Spinner className="h-4 w-4" /> : <Plus size={16} aria-hidden="true" />}>{t('pages.admin.import')}</Button>
      </form>
      <ErrorLine text={error} />

      {sources.length > 0 && (
        <ul className="m-0 mt-4 list-none space-y-1.5 p-0">
          {sources.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-field border border-line px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sous text-ink" translate="no">{s.name}</div>
                <div className="truncate font-mono text-meta text-ink-3" translate="no">{s.url}</div>
              </div>
              {s.lastError ? (
                <Pill tone="alert" data className="max-w-[40%] truncate">{s.lastError}</Pill>
              ) : (
                <span className="meta shrink-0">{t('pages.admin.programmes', { n: s.count })}</span>
              )}
              <Button variant="quiet" iconOnly onClick={() => remove(s.id)} aria-label={t('pages.admin.delete')} title={t('pages.admin.delete')} icon={<Trash2 size={16} aria-hidden="true" />} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
