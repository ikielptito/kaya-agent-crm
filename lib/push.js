// Owner-facing Web Push — fans a notification out to every device the owner has
// installed the Maya chat app on (settings.push_subscriptions). Shared by the
// weekly-review notifier (cron-followups on Sundays + the notify_review_ready
// action). Best-effort: no VAPID keys or no subscriptions -> silent no-op, never
// throws, so it can never break the caller it's bolted onto.
import webpush from 'web-push';

export async function sendOwnerPush({ SUPABASE_URL, headers }, payload) {
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return { sent: 0, reason: 'no_vapid' };
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:ikielptito@gmail.com', pub, priv);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.push_subscriptions&select=value`, { headers });
    const subs = (await r.json())?.[0]?.value || [];
    if (!Array.isArray(subs) || !subs.length) return { sent: 0, reason: 'no_subs' };
    const body = JSON.stringify(payload);
    let sent = 0;
    for (const s of subs) { try { await webpush.sendNotification(s, body); sent++; } catch (_) { /* dead/expired sub */ } }
    return { sent, devices: subs.length };
  } catch (e) { return { sent: 0, reason: e.message }; }
}

// The weekly self-review notification: a one-line summary + a deep link that
// opens the approval panel (the 🎓 button surface) in the chat app. sw.js reads
// the flat fields (title/body/url/tag) and carries `review` into notification
// data so the tap routes to openReview() instead of an agent thread.
export function buildReviewPushPayload(pending) {
  const grade = pending?.scoreboard?.grade;
  const issues = pending?.scoreboard?.issues_found;
  const lessons = pending?.lessons?.length || 0;
  const questions = pending?.questions?.length || 0;
  const bits = [];
  if (grade) bits.push(`Grade ${grade}`);
  if (typeof issues === 'number') bits.push(`${issues} issue${issues === 1 ? '' : 's'}`);
  bits.push(`${lessons} lesson${lessons === 1 ? '' : 's'}`);
  if (questions) bits.push(`${questions} question${questions === 1 ? '' : 's'}`);
  return {
    title: 'Maya’s weekly self-review',
    body: `${bits.join(' · ')}. Tap to review and approve.`,
    url: '/chat.html?review=1',
    tag: 'maya-review',
    review: true,
  };
}
