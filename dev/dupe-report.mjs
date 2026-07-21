// Duplicate-candidate report: blank-wa_num agents vs numbered agents.
const r = await fetch('https://kaya-agent-crm.vercel.app/api/supabase', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'get_agents' }),
});
const agents = await r.json();
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (a) => new Set([...norm(a.name).split(' '), ...norm(a.agency).split(' ')].filter(t => t.length > 2));
const blanks = agents.filter(a => !String(a.wa_num || '').replace(/\D/g, ''));
const numbered = agents.filter(a => String(a.wa_num || '').replace(/\D/g, ''));
for (const b of blanks.sort((x, y) => x.id - y.id)) {
  const bt = tokens(b);
  const scored = numbered.map(n => {
    const nt = tokens(n);
    let hits = 0;
    for (const t of bt) if (nt.has(t)) hits++;
    // name-only exact match is a strong signal
    const nameEq = norm(b.name) && norm(b.name) === norm(n.name) ? 2 : 0;
    return { n, score: hits + nameEq };
  }).filter(s => s.score >= 2).sort((a, c) => c.score - a.score).slice(0, 3);
  const label = `#${String(b.id).padEnd(5)} ${(b.name || '(no name)').padEnd(26).slice(0,26)} ${(b.agency || '').padEnd(24).slice(0,24)}`;
  if (!scored.length) { console.log(label + ' → no match found'); continue; }
  console.log(label + ' → ' + scored.map(s => `#${s.n.id} ${s.n.name}${s.n.agency ? ' (' + s.n.agency + ')' : ''} +${s.n.wa_num}`).join('  |  '));
}
console.log(`\n${blanks.length} blank cards checked against ${numbered.length} numbered agents.`);
