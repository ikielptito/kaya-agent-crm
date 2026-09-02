// Every row, not the first thousand.
//
// PostgREST caps a single response at 1,000 rows no matter what `limit=`
// asks for, and it does so silently: the request succeeds, the array is just
// short. Every read here that asked for 10,000 or 20,000 was getting 1,000
// — the console's analytics, the campaign command center, the assistant's
// activity summaries, the broadcast "already contacted" sets — and at ~1,000
// outbound messages a week that meant a 30-day window under-counted by
// three quarters. Proven 3 Sep 2026: a 77-day read came back as exactly
// 1,000 rows twice.
//
// `sbRows` pages with limit/offset until a short page. Callers pass the path
// WITHOUT a limit and WITH a stable order (id.asc unless there is a reason),
// so offsets are deterministic while rows are being inserted.
export async function sbRows(baseUrl, headers, path, { page = 1000, max = 50000 } = {}) {
  const all = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let offset = 0; offset < max; offset += page) {
    const r = await fetch(`${baseUrl}/rest/v1/${path}${sep}limit=${page}&offset=${offset}`, { headers });
    if (!r.ok) break;
    const rows = await r.json().catch(() => null);
    if (!Array.isArray(rows) || !rows.length) break;
    all.push(...rows);
    if (rows.length < page) break;
  }
  return all;
}
