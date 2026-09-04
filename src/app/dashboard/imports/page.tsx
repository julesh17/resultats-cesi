'use client';

import { FormEvent, useEffect, useState } from 'react';
import { FileSpreadsheet, UploadCloud, History } from 'lucide-react';
import Loading from '@/components/Loading';
import SessionSelect from '@/components/SessionSelect';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import type { CesiSession } from '@/lib/types';

interface ImportHistoryRow {
  id: string;
  kind: 'notes' | 'referentiel';
  file_name: string;
  session_id: string | null;
  rows_count: number;
  created_at: string;
  metadata: Record<string, unknown>;
}

export default function ImportsPage() {
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<CesiSession[]>([]);
  const [history, setHistory] = useState<ImportHistoryRow[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [notesFile, setNotesFile] = useState<File | null>(null);
  const [rnFile, setRnFile] = useState<File | null>(null);
  const [notesResult, setNotesResult] = useState('');
  const [rnResult, setRnResult] = useState('');
  const [busy, setBusy] = useState<'notes' | 'rn' | null>(null);

  async function load() {
    const supabase = getSupabaseBrowser();
    const [s, h] = await Promise.all([
      supabase.from('sessions').select('*').order('name'),
      supabase.from('import_history').select('*').order('created_at', { ascending: false }).limit(20),
    ]);
    setSessions((s.data || []) as CesiSession[]);
    setHistory((h.data || []) as ImportHistoryRow[]);
    if (!sessionId && s.data?.length) setSessionId(s.data[0].id);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function apiUpload(endpoint: string, form: FormData) {
    const { data } = await getSupabaseBrowser().auth.getSession();
    if (!data.session) throw new Error('Session expirée.');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${data.session.access_token}` },
      body: form,
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(json.error || 'Import impossible.');
    }
    return json;
  }

  async function importNotes(event: FormEvent) {
    event.preventDefault();
    if (!notesFile) return;
    setBusy('notes'); setNotesResult('');
    try {
      const form = new FormData();
      form.append('file', notesFile);
      const json = await apiUpload('/api/import/notes', form);
      const created = json.sessions_created ? ` · ${json.sessions_created} session(s) créée(s) automatiquement` : '';
      const missingCode = json.sessions_without_analytic_code ? ` · ${json.sessions_without_analytic_code} code(s) analytique(s) à renseigner` : '';
      setNotesResult(`Import terminé : ${json.sessions} session(s), ${json.students} étudiant(s), ${json.grades} cellule(s) de note${created}${missingCode}. ${json.debts_created || 0} nouvelle(s) dette(s) détectée(s).`);
      await load();
    } catch (e) {
      setNotesResult(`Erreur : ${e instanceof Error ? e.message : 'Import impossible.'}`);
    } finally { setBusy(null); }
  }

  async function importReferentiel(event: FormEvent) {
    event.preventDefault();
    if (!rnFile || !sessionId) return;
    setBusy('rn'); setRnResult('');
    try {
      const form = new FormData();
      form.append('file', rnFile);
      form.append('session_id', sessionId);
      const json = await apiUpload('/api/import/referentiel', form);
      setRnResult(`Référentiel enregistré : ${json.ues} UE et ${json.evaluations_total || (json.evaluations_matched + json.evaluations_created)} élément(s) évaluables. ${json.debts_created || 0} nouvelle(s) dette(s).`);
      await load();
    } catch (e) {
      setRnResult(`Erreur : ${e instanceof Error ? e.message : 'Import impossible.'}`);
    } finally { setBusy(null); }
  }

  if (loading) return <Loading />;

  return (
    <div className="space-y-7">
      <div>
        <h1 className="page-title">Imports</h1>
        <p className="page-subtitle">Les fichiers Excel sont conservés dans Supabase Storage et leur contenu est synchronisé dans la base.</p>
      </div>

      <div className="grid xl:grid-cols-2 gap-5">
        <section className="card p-5 md:p-6">
          <div className="flex items-center gap-2 mb-2"><FileSpreadsheet className="text-blue-600" size={20} /><h2 className="section-title">Notes — import général</h2></div>
          <p className="text-sm muted mb-5">Un seul fichier peut contenir plusieurs sessions grâce à la colonne <strong>Session</strong>. Si une session n’existe pas encore, elle est créée automatiquement.</p>
          <form onSubmit={importNotes} className="space-y-4">
            <label className="block">
              <span className="form-label">Fichier de notes .xlsx</span>
              <input className="form-input file:mr-3 file:border-0 file:bg-transparent file:font-medium" type="file" accept=".xlsx" onChange={(e) => setNotesFile(e.target.files?.[0] || null)} required />
            </label>
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-3 text-xs text-blue-800">
              Une réimportation met à jour les mêmes étudiants, évaluations et notes. Si le fichier contient une colonne <strong>Code analytique</strong>, elle est utilisée lors de la création automatique ; sinon le code pourra être renseigné ensuite dans <strong>Sessions</strong>.
            </div>
            <button className="btn-primary" disabled={!notesFile || busy !== null}><UploadCloud size={16} /> {busy === 'notes' ? 'Import en cours…' : 'Importer les notes'}</button>
            {notesResult ? <div className={`rounded-xl p-3 text-sm border ${notesResult.startsWith('Erreur') ? 'bg-red-50 border-red-200 text-red-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700'}`}>{notesResult}</div> : null}
          </form>
        </section>

        <section className="card p-5 md:p-6">
          <div className="flex items-center gap-2 mb-2"><FileSpreadsheet className="text-blue-600" size={20} /><h2 className="section-title">Cahier des charges / référentiel</h2></div>
          <p className="text-sm muted mb-5">Le référentiel est rattaché à une session choisie. Il alimente les UE, coefficients, ECTS et la logique de compensation / jury.</p>
          <form onSubmit={importReferentiel} className="space-y-4">
            <SessionSelect sessions={sessions} value={sessionId} onChange={setSessionId} />
            <label className="block">
              <span className="form-label">Référentiel .xlsx</span>
              <input className="form-input file:mr-3 file:border-0 file:bg-transparent file:font-medium" type="file" accept=".xlsx" onChange={(e) => setRnFile(e.target.files?.[0] || null)} required />
            </label>
            <button className="btn-primary" disabled={!rnFile || !sessionId || busy !== null}><UploadCloud size={16} /> {busy === 'rn' ? 'Import en cours…' : 'Mettre à jour le référentiel'}</button>
            {rnResult ? <div className={`rounded-xl p-3 text-sm border ${rnResult.startsWith('Erreur') ? 'bg-red-50 border-red-200 text-red-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700'}`}>{rnResult}</div> : null}
          </form>
        </section>
      </div>

      <section className="card overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: 'var(--border)' }}><History size={18} className="text-blue-600" /><h2 className="section-title">Derniers imports</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead><tr><th className="table-header">Date</th><th className="table-header">Type</th><th className="table-header">Fichier</th><th className="table-header">Session</th><th className="table-header text-right">Lignes</th></tr></thead>
            <tbody>
              {history.map((row) => {
                const session = sessions.find((s) => s.id === row.session_id);
                return <tr key={row.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="table-cell whitespace-nowrap">{new Date(row.created_at).toLocaleString('fr-FR')}</td>
                  <td className="table-cell"><span className="status-badge bg-gray-50 border-gray-200">{row.kind === 'notes' ? 'Notes' : 'Référentiel'}</span></td>
                  <td className="table-cell font-medium">{row.file_name}</td>
                  <td className="table-cell">{session?.name || (row.kind === 'notes' ? 'Import multi-session' : '—')}</td>
                  <td className="table-cell text-right">{row.rows_count}</td>
                </tr>;
              })}
              {!history.length ? <tr><td colSpan={5} className="p-8 text-center text-sm muted">Aucun import enregistré.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
