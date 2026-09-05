// An owner who is also one of our rental agents.
//
// Dony Bambang (Aug 2026) was quick-added as an agent in July, then listed
// his own villa in August and was switched to owner mode — correctly, since
// he mostly writes as an owner. But owner-mode Maya had no idea he was also
// in the agent network, so a question like "may I know fee rent for villa?"
// could only be read from the owner side. Both sides rest on the same 10%,
// and a good answer covers both in two lines. This block tells her.

const digits = (v) => String(v || '').replace(/\D/g, '');

export async function findAgentByNumber(db, waNum) {
  const n = digits(waNum);
  if (!n || !db?.SUPABASE_URL) return null;
  try {
    const r = await fetch(`${db.SUPABASE_URL}/rest/v1/agents?wa_num=eq.${n}&is_test=eq.false&select=id,name,agency,samba_account_status&limit=1`, { headers: db.sbHeaders });
    const rows = r.ok ? await r.json() : [];
    return rows?.[0] || null;
  } catch { return null; }
}

export function dualRoleBlock(agent) {
  if (!agent) return '';
  const who = [agent.name, agent.agency].filter(Boolean).join(' · ') || `agent #${agent.id}`;
  return `
ALSO AN AGENT: this owner is ALSO a registered rental agent in the Samba network (${who}). They market Samba's villas to their own clients as well as listing their own. So a question can come from either side, and if it is ambiguous, answer both sides briefly rather than guessing:
- OWNER side (their own villa): Samba takes no commission and no monthly fee for a founding villa. The agent's 10% comes out of the price they listed — the agent quotes that price, and they pay the agent 10% of it from the rent and keep 90% (35jt listed → 3.5jt to the agent, 31.5jt net). They deal with the tenant directly.
- AGENT side (bringing their client to another Samba villa): the 10% agent fee comes out of the portal price — they quote the portal price and the owner (or Samba, on a managed villa) pays them 10% of it when the deal closes. Live availability and every villa's details are at https://sambarentals.com (sign in with Google for the agent account).
Never tell them they are "not an agent" or route them elsewhere for agent questions — answer here, in one conversation.
`;
}
