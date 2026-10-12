// Push notifications to coaches/admins ("call attention", reports). The existing `mstc-push` Worker and its API are not
// part of this project's files, so this is a deliberately small hook: if PUSH_URL is set, it POSTs
// {title, body, audience:"staff"} there (with `Authorization: Bearer PUSH_SECRET`). Adapt the payload to whatever
// mstc-push expects. Without PUSH_URL it does nothing, and chat works the same.
export async function notifyStaff(env, { title, body }) {
  if (!env.PUSH_URL) return false;
  try {
    const res = await fetch(env.PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ...(env.PUSH_SECRET ? { authorization: `Bearer ${env.PUSH_SECRET}` } : {}) },
      body: JSON.stringify({ title, body, audience: "staff" }),
    });
    return res.ok;
  } catch {
    return false; // push is best-effort
  }
}
