type QueryError = { message: string } | null;
type QueryPage<T> = { data: T[] | null; error: QueryError };

/**
 * Supabase/PostgREST limite couramment une réponse à 1000 lignes.
 * Cette fonction lit toutes les pages d'une requête, avec un ordre stable.
 */
export async function fetchAllRows<T>(
  buildPage: (from: number, to: number) => PromiseLike<QueryPage<T>>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;

  for (let page = 0; page < 1000; page += 1) {
    const result = await buildPage(from, from + pageSize - 1);
    if (result.error) throw new Error(result.error.message);
    const data = result.data || [];
    rows.push(...data);
    if (data.length < pageSize) return rows;
    from += pageSize;
  }

  throw new Error('Lecture interrompue : volume de données anormalement élevé.');
}
