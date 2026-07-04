import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { ArrowLeft, RefreshCw, UserPlus, Trash2, ShieldCheck, Ban, Loader2, ListVideo, Plus, AlertCircle, Crown, CalendarClock, Wifi } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/store/authStore';
import { useCatalog } from '@/store/catalogStore';
import type { User } from '@/types';

interface Source {
  id: string;
  name: string;
  url: string | null;
  count: number;
  lastError: string | null;
  lastFetched: number | null;
}

export function AdminDashboard() {
  const navigate = useNavigate();
  const { user, isAdmin } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', role: 'user' });
  const [err, setErr] = useState<string | null>(null);
  // Run a mutation, surface its error, and refresh.
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e?.message || 'Action échouée');
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

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ users: User[] }>('/admin/users');
      setUsers(r.users);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    await act(async () => {
      await api.post('/admin/users', form);
      setForm({ email: '', password: '', role: 'user' });
    });
  };

  const patch = (id: string, body: Partial<User>) => act(() => api.patch(`/admin/users/${id}`, body));
  const remove = (id: string) => act(() => api.del(`/admin/users/${id}`));
  const setUserPlan = (id: string, plan: 'free' | 'premium') => act(() => api.post(`/admin/users/${id}/plan`, { plan }));

  const refreshCatalog = async () => {
    setRefreshing(true);
    await api.post('/catalog/refresh').catch(() => {});
    setRefreshing(false);
  };

  const [sweep, setSweep] = useState<string | null>(null);
  const runSweep = async () => {
    setSweep('Lancement du test de toutes les chaînes…');
    try {
      const r = await api.post<{ started: boolean; checked: number; online: number; offline: number }>('/admin/health/sweep');
      setSweep(r.started ? `Sweep lancé en arrière-plan (déjà ${r.checked} testées · ${r.online} en ligne).` : 'Sweep déjà en cours.');
    } catch {
      setSweep('Sweep indisponible.');
    }
  };

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-6 flex items-center gap-3">
        <button onClick={() => navigate('/')} className="rounded-lg border border-white/10 p-2 text-ink/60 hover:text-ink">
          <ArrowLeft size={16} />
        </button>
        <h1 className="text-lg font-semibold text-ink">Administration</h1>
        <button
          onClick={refreshCatalog}
          disabled={refreshing}
          className="ml-auto flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs text-accent hover:bg-accent/20"
        >
          {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Rafraîchir le catalogue
        </button>
        <button
          onClick={runSweep}
          className="flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-ink/70 hover:border-accent/30 hover:text-accent"
          title="Tester la disponibilité de toutes les chaînes en arrière-plan"
        >
          <Wifi size={14} /> Tester les chaînes
        </button>
      </div>
      {sweep && <p className="mb-4 rounded-lg bg-white/[0.04] px-3 py-2 text-xs text-ink/70">{sweep}</p>}

      {err && (
        <p className="mb-4 flex items-center gap-1.5 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-400">
          <AlertCircle size={13} /> {err}
        </p>
      )}

      {/* Create user */}
      <form onSubmit={createUser} className="mb-6 flex flex-wrap items-end gap-2 rounded-xl border border-white/[0.06] bg-panel/60 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-ink/80">
          <UserPlus size={16} className="text-accent" /> Nouvel utilisateur
        </div>
        <input required type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="input flex-1" />
        <input required type="password" minLength={6} placeholder="Mot de passe (min 6)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="input flex-1" />
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="input">
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black hover:opacity-90">
          Créer
        </button>
      </form>

      {/* User list */}
      <div className="overflow-hidden rounded-xl border border-white/[0.06]">
        <table className="w-full text-left text-sm">
          <thead className="bg-white/[0.03] font-mono text-[10px] uppercase tracking-wider text-ink/40">
            <tr>
              <th className="px-4 py-2">Email</th>
              <th className="px-4 py-2">Rôle</th>
              <th className="px-4 py-2">Statut</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-ink/40">
                  <Loader2 className="mx-auto animate-spin" />
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="border-t border-white/[0.04]">
                  <td className="px-4 py-2.5 text-ink/80">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <span className={clsx('rounded px-1.5 py-0.5 font-mono text-[10px]', u.role === 'admin' ? 'bg-accent/15 text-accent' : 'bg-white/5 text-ink/50')}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={clsx('font-mono text-[10px]', u.status === 'active' ? 'text-emerald-400' : 'text-rose-400')}>{u.status}</span>
                    <span className={clsx('ml-2 rounded px-1.5 py-0.5 font-mono text-[9px]', u.plan === 'premium' || u.premium ? 'bg-amber-500/15 text-amber-300' : 'bg-white/5 text-ink/40')}>
                      {u.plan === 'premium' || u.premium ? 'premium' : 'free'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => setUserPlan(u.id, u.plan === 'premium' ? 'free' : 'premium')} title="Basculer Premium" className={clsx('rounded p-1.5 hover:text-amber-300', u.plan === 'premium' ? 'text-amber-400' : 'text-ink/50')}>
                        <Crown size={14} />
                      </button>
                      <button onClick={() => patch(u.id, { role: u.role === 'admin' ? 'user' : 'admin' })} title="Basculer admin" className="rounded p-1.5 text-ink/50 hover:text-accent">
                        <ShieldCheck size={14} />
                      </button>
                      <button onClick={() => patch(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })} title="Activer/Désactiver" className="rounded p-1.5 text-ink/50 hover:text-amber-400">
                        <Ban size={14} />
                      </button>
                      <button onClick={() => remove(u.id)} disabled={u.id === user?.id} title="Supprimer" className="rounded p-1.5 text-ink/50 hover:text-rose-400 disabled:opacity-30">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AuditPanel />
      <SourcesManager />
      <EpgManager />
    </div>
  );
}

interface ConfigAudit { billingProvider: string; stripeConfigured: boolean; adsenseConfigured: boolean; jwtSecretExplicit: boolean; warnings: { level: string; key: string; msg: string }[]; }
interface ChannelAudit { total: number; online: number; offline: number; unchecked: number; byCategory: Record<string, { total: number; online: number; offline: number; unchecked: number }>; }

function AuditPanel() {
  const [cfg, setCfg] = useState<ConfigAudit | null>(null);
  const [ch, setCh] = useState<ChannelAudit | null>(null);
  const load = async () => {
    setCfg(await api.get<ConfigAudit>('/admin/config').catch(() => null));
    setCh(await api.get<ChannelAudit>('/admin/channels/audit').catch(() => null));
  };
  useEffect(() => { load(); }, []);

  const lvlColor: Record<string, string> = { error: 'text-rose-400', warn: 'text-amber-400', info: 'text-ink/50' };
  const pct = ch && ch.total ? Math.round((ch.online / ch.total) * 100) : 0;

  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck size={18} className="text-accent" />
        <h2 className="text-base font-semibold text-ink">Audit système</h2>
        <button onClick={load} className="ml-auto rounded-lg border border-white/10 p-1.5 text-ink/50 hover:text-accent" title="Rafraîchir"><RefreshCw size={13} /></button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Config audit */}
        <div className="rounded-xl border border-white/[0.06] bg-panel/60 p-4">
          <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-ink/40">Configuration</h3>
          {cfg ? (
            <>
              <div className="mb-2 flex flex-wrap gap-2 text-[11px]">
                <Chip ok={cfg.jwtSecretExplicit}>JWT secret</Chip>
                <Chip ok={cfg.billingProvider === 'stripe' ? cfg.stripeConfigured : true}>Billing: {cfg.billingProvider}</Chip>
                <Chip ok={cfg.adsenseConfigured}>AdSense</Chip>
              </div>
              {cfg.warnings.length === 0 ? (
                <p className="text-xs text-emerald-400">Aucun problème détecté.</p>
              ) : (
                <ul className="space-y-1">
                  {cfg.warnings.map((w, i) => (
                    <li key={i} className={clsx('text-[11px]', lvlColor[w.level])}>• <b>{w.key}</b>: {w.msg}</li>
                  ))}
                </ul>
              )}
            </>
          ) : <p className="text-xs text-ink/40">…</p>}
        </div>

        {/* Channel health audit */}
        <div className="rounded-xl border border-white/[0.06] bg-panel/60 p-4">
          <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-ink/40">Santé des chaînes</h3>
          {ch ? (
            <>
              <div className="mb-2 flex h-2 overflow-hidden rounded-full bg-white/5">
                <span className="bg-emerald-500" style={{ width: `${(ch.online / ch.total) * 100}%` }} />
                <span className="bg-rose-500/70" style={{ width: `${(ch.offline / ch.total) * 100}%` }} />
              </div>
              <p className="text-xs text-ink/70">
                <span className="text-emerald-400">{ch.online.toLocaleString('fr')} en ligne</span> ·{' '}
                <span className="text-rose-400">{ch.offline.toLocaleString('fr')} hors-ligne</span> ·{' '}
                <span className="text-ink/40">{ch.unchecked.toLocaleString('fr')} non testées</span>
              </p>
              <p className="mt-1 text-[11px] text-ink/40">{pct}% jouables sur le total · lancez "Tester les chaînes" pour auditer le reste.</p>

              {/* Per-category playability bars */}
              <div className="mt-4 space-y-1.5">
                <h4 className="mb-1 font-mono text-[10px] font-bold uppercase tracking-widest text-ink/40">Par catégorie (top 12)</h4>
                {Object.entries(ch.byCategory)
                  .map(([k, v]) => ({ k, ...v }))
                  .sort((a, b) => b.total - a.total)
                  .slice(0, 12)
                  .map((c) => (
                    <div key={c.k} className="flex items-center gap-2">
                      <span className="w-24 shrink-0 truncate text-[10px] text-ink/55" title={c.k}>{c.k === 'undefined' ? 'Autres' : c.k}</span>
                      <div className="flex h-2.5 flex-1 overflow-hidden rounded-full bg-white/5" title={`${c.online} en ligne · ${c.offline} hors-ligne · ${c.unchecked} non testées`}>
                        <span className="bg-emerald-500" style={{ width: `${c.total ? (c.online / c.total) * 100 : 0}%` }} />
                        <span className="bg-rose-500/60" style={{ width: `${c.total ? (c.offline / c.total) * 100 : 0}%` }} />
                      </div>
                      <span className="w-12 shrink-0 text-right font-mono text-[9px] text-ink/40">{c.total.toLocaleString('fr')}</span>
                    </div>
                  ))}
              </div>
            </>
          ) : <p className="text-xs text-ink/40">…</p>}
        </div>
      </div>
    </div>
  );
}

function Chip({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={clsx('rounded px-1.5 py-0.5 font-mono', ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/5 text-ink/40')}>
      {ok ? '✓' : '·'} {children}
    </span>
  );
}

function SourcesManager() {
  const loadMeta = useCatalog((s) => s.loadMeta);
  const loadChannels = useCatalog((s) => s.loadChannels);
  const [sources, setSources] = useState<Source[]>([]);
  const [mode, setMode] = useState<'url' | 'text'>('url');
  const [form, setForm] = useState({ name: '', url: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.get<{ sources: Source[] }>('/sources');
      setSources(r.sources);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    load();
  }, []);

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
      refreshCatalog();
    } catch (err: any) {
      setError(err?.message || "Import impossible");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const r = await api.del<{ sources: Source[] }>(`/admin/sources/${id}`).catch(() => null);
    if (r) setSources(r.sources);
    refreshCatalog();
  };

  const refresh = async () => {
    setBusy(true);
    const r = await api.post<{ sources: Source[] }>('/admin/sources/refresh').catch(() => null);
    if (r) setSources(r.sources);
    await refreshCatalog();
    setBusy(false);
  };

  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <ListVideo size={18} className="text-accent" />
        <h2 className="text-base font-semibold text-ink">Sources M3U / IPTV</h2>
        <span className="text-[11px] text-ink/40">Importez votre propre playlist (fournisseur, abonnement, fichier perso).</span>
        {sources.length > 0 && (
          <button onClick={refresh} disabled={busy} className="ml-auto flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-[11px] text-ink/60 hover:text-accent">
            <RefreshCw size={13} className={clsx(busy && 'animate-spin')} /> Rafraîchir
          </button>
        )}
      </div>

      <form onSubmit={add} className="mb-4 rounded-xl border border-white/[0.06] bg-panel/60 p-4">
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg border border-white/10 p-1 sm:max-w-xs">
          {(['url', 'text'] as const).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={clsx('rounded-md py-1.5 text-xs', mode === m ? 'bg-accent/15 text-accent' : 'text-ink/50')}>
              {m === 'url' ? 'Depuis une URL' : 'Coller le M3U'}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input required placeholder="Nom (ex: Mon fournisseur)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input sm:w-56" />
          {mode === 'url' ? (
            <input required type="url" placeholder="https://.../playlist.m3u" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="input flex-1" />
          ) : (
            <textarea required placeholder="#EXTM3U&#10;#EXTINF:-1 ...,Nom&#10;https://..." value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} className="input min-h-[80px] flex-1 font-mono text-[11px]" />
          )}
          <button type="submit" disabled={busy} className="flex items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Importer
          </button>
        </div>
        {error && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-rose-400">
            <AlertCircle size={13} /> {error}
          </p>
        )}
      </form>

      {sources.length > 0 && (
        <div className="space-y-1.5">
          {sources.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-panel/40 px-3 py-2">
              <ListVideo size={15} className="shrink-0 text-accent/70" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink/80">{s.name}</div>
                <div className="truncate text-[10px] text-ink/40">{s.url || 'playlist collée'}</div>
              </div>
              {s.lastError ? (
                <span className="shrink-0 font-mono text-[10px] text-rose-400">{s.lastError}</span>
              ) : (
                <span className="shrink-0 font-mono text-[10px] text-emerald-400">{s.count} chaînes</span>
              )}
              <button onClick={() => remove(s.id)} className="shrink-0 rounded p-1.5 text-ink/50 hover:text-rose-400" aria-label="Supprimer">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface EpgSource {
  id: string;
  name: string;
  url: string;
  count: number;
  lastError: string | null;
}

function EpgManager() {
  const [sources, setSources] = useState<EpgSource[]>([]);
  const [form, setForm] = useState({ name: '', url: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.get<{ sources: EpgSource[] }>('/epg/sources');
      setSources(r.sources);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    load();
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ sources: EpgSource[] }>('/admin/epg', form);
      setSources(r.sources);
      setForm({ name: '', url: '' });
    } catch (err: any) {
      setError(err?.message || 'Import EPG impossible');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await api.del(`/admin/epg/${id}`).catch(() => {});
    load();
  };

  return (
    <div className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <CalendarClock size={18} className="text-accent" />
        <h2 className="text-base font-semibold text-ink">Programme TV (EPG / XMLTV)</h2>
        <span className="text-[11px] text-ink/40">Ajoutez l'URL XMLTV (epg.xml / .gz) de votre fournisseur pour le now/next et la recherche par émission.</span>
      </div>

      <form onSubmit={add} className="mb-4 flex flex-col gap-2 rounded-xl border border-white/[0.06] bg-panel/60 p-4 sm:flex-row sm:items-end">
        <input required placeholder="Nom (ex: EPG fournisseur)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input sm:w-56" />
        <input required type="url" placeholder="https://.../epg.xml(.gz)" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="input flex-1" />
        <button type="submit" disabled={busy} className="flex items-center justify-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Importer
        </button>
      </form>
      {error && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-rose-400">
          <AlertCircle size={13} /> {error}
        </p>
      )}

      {sources.length > 0 && (
        <div className="space-y-1.5">
          {sources.map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-panel/40 px-3 py-2">
              <CalendarClock size={15} className="shrink-0 text-accent/70" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink/80">{s.name}</div>
                <div className="truncate text-[10px] text-ink/40">{s.url}</div>
              </div>
              {s.lastError ? (
                <span className="shrink-0 font-mono text-[10px] text-rose-400">{s.lastError}</span>
              ) : (
                <span className="shrink-0 font-mono text-[10px] text-emerald-400">{s.count.toLocaleString('fr')} programmes</span>
              )}
              <button onClick={() => remove(s.id)} className="shrink-0 rounded p-1.5 text-ink/50 hover:text-rose-400" aria-label="Supprimer">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
