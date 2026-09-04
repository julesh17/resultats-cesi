'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Bell, BellOff, Pencil, Plus, Trash2 } from 'lucide-react';
import Loading from '@/components/Loading';
import Modal from '@/components/Modal';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import type { CesiSession, CycleType } from '@/lib/types';
import { cycleYears, normalizeAnalyticCode } from '@/lib/utils';

function readableSessionError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes('sessions_analytic_code') || lower.includes('analytic_code') && lower.includes('duplicate')) {
    return 'Ce code analytique est déjà utilisé. Les majuscules et minuscules sont considérées comme équivalentes.';
  }
  if (lower.includes('sessions_name_key') || lower.includes('duplicate key')) {
    return 'Une session portant ce nom ou ce code analytique existe déjà.';
  }
  return message;
}

export default function SessionsPage() {
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<CesiSession[]>([]);
  const [subscriptions, setSubscriptions] = useState<Set<string>>(new Set());
  const [userId, setUserId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState<CesiSession | null>(null);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [cycle, setCycle] = useState<CycleType>('ingenieur');

  async function load() {
    const supabase = getSupabaseBrowser();
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth.user?.id || '';
    setUserId(uid);
    const [s, sub] = await Promise.all([
      supabase.from('sessions').select('*').order('name'),
      uid
        ? supabase.from('session_subscriptions').select('session_id').eq('user_id', uid)
        : Promise.resolve({ data: [] as Array<{ session_id: string }> }),
    ]);
    setSessions((s.data || []) as CesiSession[]);
    setSubscriptions(new Set(((sub.data || []) as Array<{ session_id: string }>).map((x) => x.session_id)));
    if (s.error) setError(readableSessionError(s.error.message));
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function createSession(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSaving(true);
    const supabase = getSupabaseBrowser();
    const { data, error: insertError } = await supabase.from('sessions').insert({
      name: name.trim(),
      analytic_code: normalizeAnalyticCode(code),
      cycle,
      created_by: userId || null,
    }).select('*').single();

    if (insertError) {
      setError(readableSessionError(insertError.message));
    } else {
      if (userId && data?.id) {
        const { error: followError } = await supabase
          .from('session_subscriptions')
          .upsert({ user_id: userId, session_id: data.id });
        if (followError) setError(readableSessionError(followError.message));
      }
      setName('');
      setCode('');
      setCycle('ingenieur');
      await load();
    }
    setSaving(false);
  }

  async function toggleFollow(sessionId: string) {
    if (!userId) return;
    setError('');
    const supabase = getSupabaseBrowser();
    const result = subscriptions.has(sessionId)
      ? await supabase.from('session_subscriptions').delete().eq('user_id', userId).eq('session_id', sessionId)
      : await supabase.from('session_subscriptions').upsert({ user_id: userId, session_id: sessionId });
    if (result.error) setError(readableSessionError(result.error.message));
    await load();
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!edit) return;
    setError('');
    const form = new FormData(event.currentTarget);
    const codeValue = normalizeAnalyticCode(String(form.get('analytic_code') || ''));
    const supabase = getSupabaseBrowser();
    const { error: updateError } = await supabase.from('sessions').update({
      name: String(form.get('name') || '').trim(),
      analytic_code: codeValue || null,
    }).eq('id', edit.id);
    if (updateError) setError(readableSessionError(updateError.message));
    else { setEdit(null); await load(); }
  }

  async function remove(session: CesiSession) {
    if (!window.confirm(`Supprimer définitivement la session « ${session.name} » et toutes ses données ?`)) return;
    setError('');
    const { error: deleteError } = await getSupabaseBrowser().from('sessions').delete().eq('id', session.id);
    if (deleteError) setError(readableSessionError(deleteError.message));
    else await load();
  }

  if (loading) return <Loading />;

  return (
    <div className="space-y-7">
      <div>
        <h1 className="page-title">Sessions</h1>
        <p className="page-subtitle">Une session est identifiée par son nom et son code analytique. Tous les comptes peuvent la consulter et la modifier.</p>
      </div>

      <section className="card p-5 md:p-6">
        <div className="flex items-center gap-2 mb-5"><Plus size={18} className="text-blue-600" /><h2 className="section-title">Créer une session</h2></div>
        <form onSubmit={createSession} className="grid md:grid-cols-2 xl:grid-cols-4 gap-4 items-end">
          <label className="block xl:col-span-2">
            <span className="form-label">Nom de la session</span>
            <input className="form-input" placeholder="FISA S3E 24-27" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="block">
            <span className="form-label">Code analytique</span>
            <input className="form-input" placeholder="tl42t201" value={code} onChange={(e) => setCode(e.target.value)} required autoCapitalize="none" />
            <span className="mt-1 block text-[11px] muted">La casse n’est pas prise en compte : TL42 et tl42 sont équivalents.</span>
          </label>
          <label className="block">
            <span className="form-label">Cycle</span>
            <select className="form-select" value={cycle} onChange={(e) => setCycle(e.target.value as CycleType)}>
              <option value="ingenieur">Cycle ingénieur · A3/A4/A5</option>
              <option value="cpi">CPI · A1/A2</option>
            </select>
          </label>
          <div className="xl:col-span-4 flex justify-end">
            <button className="btn-primary" disabled={saving}><Plus size={16} /> {saving ? 'Création…' : 'Créer la session'}</button>
          </div>
        </form>
        {error ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="section-title">Toutes les sessions</h2>
          <span className="text-xs muted">{sessions.length} session(s)</span>
        </div>
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {sessions.map((session) => (
            <article className="card p-5" key={session.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-semibold leading-snug">{session.name}</h3>
                  <p className={`text-sm mt-1 ${session.analytic_code ? 'muted' : 'text-amber-700'}`}>
                    {session.analytic_code || 'Code analytique à renseigner'}
                  </p>
                </div>
                <button className={subscriptions.has(session.id) ? 'btn-primary !p-2' : 'btn-secondary !p-2'} title={subscriptions.has(session.id) ? 'Se désabonner' : 'Suivre cette session'} onClick={() => toggleFollow(session.id)}>
                  {subscriptions.has(session.id) ? <Bell size={16} /> : <BellOff size={16} />}
                </button>
              </div>
              <div className="flex flex-wrap gap-2 mt-4">
                {cycleYears(session.cycle).map((y) => (
                  <span key={y.label} className="status-badge bg-gray-50 border-gray-200 text-gray-700">
                    {y.label} · S{y.semesters[0]}–S{y.semesters[1]}
                  </span>
                ))}
              </div>
              <div className="mt-5 pt-4 border-t flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
                <span className="text-xs muted">{subscriptions.has(session.id) ? 'Suivie dans votre tableau de bord' : 'Visible, mais non suivie'}</span>
                <div className="flex gap-2">
                  <button className="btn-secondary !p-2" onClick={() => setEdit(session)} title="Modifier"><Pencil size={15} /></button>
                  <button className="btn-danger !p-2" onClick={() => remove(session)} title="Supprimer"><Trash2 size={15} /></button>
                </div>
              </div>
            </article>
          ))}
          {!sessions.length ? <div className="card p-8 text-sm muted md:col-span-2 xl:col-span-3 text-center">Aucune session pour le moment. Vous pouvez aussi importer directement un fichier de notes : les sessions inconnues seront créées automatiquement.</div> : null}
        </div>
      </section>

      <Modal open={Boolean(edit)} onClose={() => setEdit(null)} title="Modifier la session">
        {edit ? (
          <form className="space-y-4" onSubmit={saveEdit}>
            <label className="block"><span className="form-label">Nom</span><input name="name" className="form-input" defaultValue={edit.name} required /></label>
            <label className="block">
              <span className="form-label">Code analytique</span>
              <input name="analytic_code" className="form-input" defaultValue={edit.analytic_code || ''} autoCapitalize="none" placeholder="À renseigner si la session a été créée par import" />
              <span className="mt-1 block text-[11px] muted">La casse n’est pas prise en compte.</span>
            </label>
            <div className="rounded-xl bg-gray-50 p-3 text-xs muted">Le type de cycle n’est pas modifiable après création, afin de conserver la structure A1…A5 / S1…S10 cohérente.</div>
            <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setEdit(null)}>Annuler</button><button className="btn-primary">Enregistrer</button></div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
