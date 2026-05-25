// Diagnostic endpoint: returns exactly what Maya's system prompt is currently
// pulling for portfolio context. Use this to verify whether she's reading from
// the live `projects` DB table or falling back to lib/kb.js.
//
// GET /api/debug-context

import { PORTFOLIO_CONTEXT as FALLBACK_PORTFOLIO, BROCHURES as FALLBACK_BROCHURES } from '../lib/kb.js';

export default async function handler(req, res) {
  // Simple shared-secret gate. Allow either ?secret=XXX query param OR
  // Authorization: Bearer XXX header. Falls back to allowing unauthenticated
  // if no DEBUG_SECRET env var is set (preserves legacy behaviour for dev).
  const expected = process.env.DEBUG_SECRET || process.env.CRON_SECRET;
  if (expected) {
    const provided = req.query?.secret || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided !== expected) {
      return res.status(401).json({ error: 'Unauthorized. Append ?secret=YOUR_SECRET or send Authorization: Bearer YOUR_SECRET.' });
    }
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured' });
  }

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY
  };

  let dbProjects = null;
  let dbError = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/projects?select=*&active=eq.true&order=display_order.asc`, { headers });
    if (r.ok) {
      dbProjects = await r.json();
    } else {
      dbError = `HTTP ${r.status}: ${await r.text()}`;
    }
  } catch (e) {
    dbError = e.message;
  }

  const source = (Array.isArray(dbProjects) && dbProjects.length > 0) ? 'database' : 'fallback (lib/kb.js)';
  const portfolio = (Array.isArray(dbProjects) && dbProjects.length > 0)
    ? buildPortfolioContext(dbProjects)
    : FALLBACK_PORTFOLIO;

  return res.status(200).json({
    source,
    db_projects_count: Array.isArray(dbProjects) ? dbProjects.length : 0,
    db_error: dbError,
    db_project_names: Array.isArray(dbProjects) ? dbProjects.map(p => ({ slug: p.slug, name: p.name, active: p.active, units: (p.units || []).length })) : [],
    portfolio_context_maya_sees: portfolio,
    note: source === 'fallback (lib/kb.js)'
      ? 'Maya is currently using the HARDCODED fallback because the projects table is empty or unreachable. Edits made in the Projects UI will NOT be reflected. Run the SQL migration + seed defaults to fix.'
      : 'Maya is reading live from the projects DB. Edits in the Projects UI will be reflected on her next reply (with up to 60s cache lag).'
  });
}

function buildPortfolioContext(projects) {
  const blocks = projects.map((p, i) => {
    const unitLines = (p.units || []).map(u => {
      const price = u.price_usd ? `$${(u.price_usd / 1000).toFixed(0)}K USD` : (u.price_idr ? `IDR ${(u.price_idr / 1e9).toFixed(2)}B` : 'TBC');
      const sqm = u.sqm ? `${u.sqm} sqm` : '';
      const layout = [u.beds && `${u.beds} bed`, u.baths && `${u.baths} bath`].filter(Boolean).join(', ');
      const status = u.availability && u.availability !== 'Available' ? ` -- ${u.availability.toUpperCase()}` : '';
      const notes = u.notes ? ` (${u.notes})` : '';
      return `   - ${u.code}: ${layout}${sqm ? ', ' + sqm : ''}${u.floor ? ', ' + u.floor : ''} -- ${price}${status}${notes}`;
    }).join('\n');
    const lines = [
      `${i + 1}. ${p.name.toUpperCase()}${p.area ? ' -- ' + p.area : ''}${p.full_location ? ' (' + p.full_location + ')' : ''}`,
      p.tagline ? `   ${p.tagline}` : null,
      p.property_type || p.tenure ? `   Type: ${[p.property_type, p.tenure_details || p.tenure, p.furnished].filter(Boolean).join(', ')}` : null,
      unitLines ? `   Units:\n${unitLines}` : null,
      p.construction_status || p.delivery_date ? `   Status: ${[p.construction_status, p.delivery_date].filter(Boolean).join(' -- ')}` : null,
      p.payment_plan ? `   Payment plan: ${p.payment_plan}` : null,
      p.features ? `   Features: ${p.features}` : null,
      p.roi_projections ? `   ROI: ${p.roi_projections}` : null,
      p.rental_performance ? `   Rental performance: ${p.rental_performance}` : null,
      p.distances ? `   Location: ${p.distances}` : null,
      p.maya_notes ? `   Notes for Maya: ${p.maya_notes}` : null,
      p.commission_pct ? `   Commission: ${p.commission_pct}%` : null
    ].filter(Boolean);
    return lines.join('\n');
  });
  return `KAYA portfolio (current, live from DB):\n\n${blocks.join('\n\n')}`;
}
