// Staff registry API. Same shape as api/maintenance.js: one router, POST
// { action, payload }, called by the Samba admin panel through its
// server-side proxy so the console key never reaches a browser.
//
// Actions:
//   staff_list {active_only?, role?}          the whole roster
//   staff_upsert {id?|wa_num, name, roles[], trades[], slugs[], pay_type,
//                 monthly_rate?, can_report?, active?, notes?}
//   staff_deactivate {id}
//   staff_for_slug {slug, role?, trade?}      who covers this villa

import { consoleAuthorized, setConsoleCors } from '../lib/auth.js';
import { listStaff, upsertStaff, deactivateStaff, staffForSlug } from '../lib/staff.js';

export default async function handler(req, res) {
  setConsoleCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST {action, payload}' });
  if (!consoleAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'Supabase env vars not configured' });
  const db = {
    SUPABASE_URL,
    sbHeaders: {
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
  };

  const { action, payload = {} } = req.body || {};

  try {
    if (action === 'staff_list') {
      const staff = await listStaff(db, { active_only: !!payload.active_only, role: payload.role || null });
      return res.status(200).json({ staff });
    }
    if (action === 'staff_upsert') {
      return res.status(200).json(await upsertStaff(db, payload));
    }
    if (action === 'staff_deactivate') {
      return res.status(200).json(await deactivateStaff(db, parseInt(payload.id, 10)));
    }
    if (action === 'staff_for_slug') {
      const staff = await staffForSlug(db, payload.slug, { role: payload.role || null, trade: payload.trade || null });
      return res.status(200).json({ staff });
    }
    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
