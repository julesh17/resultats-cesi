'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RotateCcw, WalletCards, ArrowRight } from 'lucide-react';
import StatCard from '@/components/StatCard';
import Loading from '@/components/Loading';
import { getSupabaseBrowser } from '@/lib/supabase/client';
import { fetchAllRows } from '@/lib/supabase/fetchAll';
import type { CesiSession, Debt, Evaluation, Grade, Student, UE } from '@/lib/types';
import { buildRetakeMap, computeStudentUEs, makeGradeMap } from '@/lib/results';
import { displayStudent } from '@/lib/utils';

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<CesiSession[]>([]);
  const [followedIds, setFollowedIds] = useState<string[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [ues, setUes] = useState<UE[]>([]);
  const [debts, setDebts] = useState<Debt[]>([]);

  useEffect(() => {
    async function load() {
      const supabase = getSupabaseBrowser();
      const { data: auth } = await supabase.auth.getUser();
      const userId = auth.user?.id;
      const [s, st, ev, gr, ue, de, sub] = await Promise.all([
        supabase.from('sessions').select('*').order('name'),
        fetchAllRows<Student>((from, to) => supabase.from('students').select('*').eq('active', true).order('id').range(from, to)),
        fetchAllRows<Evaluation>((from, to) => supabase.from('evaluations').select('*').eq('active', true).order('id').range(from, to)),
        fetchAllRows<Grade>((from, to) => supabase.from('grades').select('*').order('id').range(from, to)),
        fetchAllRows<UE>((from, to) => supabase.from('ues').select('*').eq('active', true).order('id').range(from, to)),
        fetchAllRows<Debt>((from, to) => supabase.from('debts').select('*').order('id').range(from, to)),
        userId ? supabase.from('session_subscriptions').select('session_id').eq('user_id', userId) : Promise.resolve({ data: [] as Array<{ session_id: string }> }),
      ]);
      setSessions((s.data || []) as CesiSession[]);
      setStudents(st);
      setEvaluations(ev);
      setGrades(gr);
      setUes(ue);
      setDebts(de);
      setFollowedIds((sub.data || []).map((x) => x.session_id));
      setLoading(false);
    }
    load();
  }, []);

  const dashboard = useMemo(() => {
    const targetIds = new Set(followedIds.length ? followedIds : sessions.map((s) => s.id));
    const targetSessions = sessions.filter((s) => targetIds.has(s.id));
    const complex: Array<{ student: Student; session: CesiSession; reasons: string[]; score: number }> = [];
    let currentRetakes = 0;

    for (const session of targetSessions) {
      const ss = students.filter((x) => x.session_id === session.id);
      const ee = evaluations.filter((x) => x.session_id === session.id);
      const uu = ues.filter((x) => x.session_id === session.id);
      const studentIds = new Set(ss.map((x) => x.id));
      const gg = grades.filter((x) => studentIds.has(x.student_id));
      const dd = debts.filter((x) => studentIds.has(x.student_id));
      const gradeMap = makeGradeMap(gg);

      const retakes = buildRetakeMap(ss, ee, gg, uu);
      currentRetakes += [...retakes.current.values()].reduce((sum, list) => sum + list.length, 0);

      for (const student of ss) {
        let blankAbs = 0;
        let aj = 0;
        let anj = 0;
        for (const evaluation of ee) {
          const key = `${student.id}:${evaluation.id}`;
          const grade = gradeMap.get(key);
          if (retakes.inferredBlankAbsences.has(key)) blankAbs += 1;
          if (grade?.absence === 'AJ') aj += 1;
          if (grade?.absence === 'ANJ') anj += 1;
        }
        const ueResults = computeStudentUEs(student.id, uu, ee, gradeMap, retakes.inferredBlankAbsences);
        const nonValidated = ueResults.filter((r) => !r.validated && !r.missing).length;
        const pendingDebt = dd.filter((d) => d.student_id === student.id && d.status === 'pending').length;
        const formerDebt = dd.filter((d) => d.student_id === student.id && d.status === 'validated').length;
        const reasons: string[] = [];
        if (pendingDebt) reasons.push(`${pendingDebt} dette(s) en cours`);
        if (nonValidated) reasons.push(`${nonValidated} UE non validée(s)`);
        if (blankAbs) reasons.push(`${blankAbs} absence(s)`);
        if (anj) reasons.push(`${anj} ANJ`);
        if (aj) reasons.push(`${aj} AJ`);
        if (formerDebt) reasons.push(`${formerDebt} ex-dette(s)`);
        if (reasons.length) complex.push({
          student,
          session,
          reasons,
          score: pendingDebt * 20 + nonValidated * 10 + blankAbs * 2 + anj * 4 + aj * 2 + formerDebt * 3,
        });
      }
    }
    complex.sort((a, b) => b.score - a.score || a.student.last_name.localeCompare(b.student.last_name));
    return {
      targetSessions,
      complex,
      currentRetakes,
      pendingDebts: debts.filter((d) => d.status === 'pending' && students.some((s) => s.id === d.student_id && targetIds.has(s.session_id))).length,
    };
  }, [debts, evaluations, followedIds, grades, sessions, students, ues]);

  if (loading) return <Loading />;

  return (
    <div className="space-y-7">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Tableau de bord</h1>
          <p className="page-subtitle">Les situations qui demandent votre attention apparaissent en premier.</p>
        </div>
        <Link href="/dashboard/sessions" className="btn-secondary">Gérer mes sessions suivies <ArrowRight size={16} /></Link>
      </div>

      {!sessions.length ? (
        <div className="card p-6">
          <h2 className="font-semibold">Commencez par créer une session</h2>
          <p className="text-sm muted mt-1">Vous pouvez créer une session ici ou importer directement un fichier de notes : toute session inconnue sera créée automatiquement.</p>
          <Link href="/dashboard/sessions" className="btn-primary mt-4">Créer une session</Link>
        </div>
      ) : null}

      <div className="grid sm:grid-cols-3 gap-4">
        <StatCard label="Cas particuliers" value={dashboard.complex.length} hint="UE, dettes, absences et ex-dettes" icon={AlertTriangle} />
        <StatCard label="Rattrapages" value={dashboard.currentRetakes} hint="Situations à organiser" icon={RotateCcw} />
        <StatCard label="Dettes en cours" value={dashboard.pendingDebts} hint="UE non validées après rattrapage" icon={WalletCards} />
      </div>

      <section className="card overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
          <div>
            <h2 className="section-title">Cas complexes prioritaires</h2>
            <p className="text-xs muted mt-1">Le tri favorise les dettes et les UE non validées.</p>
          </div>
          <Link href="/dashboard/jury" className="text-sm text-blue-600 font-medium">Ouvrir le jury</Link>
        </div>
        <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
          {dashboard.complex.slice(0, 20).map((item) => (
            <div key={`${item.student.id}-${item.session.id}`} className="px-5 py-4 flex flex-col md:flex-row md:items-center gap-3 justify-between">
              <div className="min-w-0">
                <div className="font-medium">{displayStudent(item.student.first_name, item.student.last_name)}</div>
                <div className="text-xs muted mt-0.5">{item.session.name}</div>
              </div>
              <div className="flex flex-wrap gap-1.5 md:justify-end">
                {item.reasons.map((r) => <span key={r} className="status-badge bg-gray-50 border-gray-200 text-gray-700">{r}</span>)}
              </div>
            </div>
          ))}
          {!dashboard.complex.length ? <div className="p-8 text-center text-sm muted">Aucun cas particulier détecté sur les sessions affichées.</div> : null}
        </div>
      </section>

      <div className="text-xs muted">
        {followedIds.length ? `Tableau de bord limité à ${dashboard.targetSessions.length} session(s) suivie(s).` : 'Aucune session suivie : le tableau de bord affiche toutes les sessions.'}
      </div>
    </div>
  );
}
