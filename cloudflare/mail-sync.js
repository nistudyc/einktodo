const API = 'https://open.feishu.cn/open-apis';
export function mailStatus(mail, now = Date.now()) {
  const known = Number.isSafeInteger(mail?.unreadCount) && mail.unreadCount >= 0;
  return { unreadCount: known ? mail.unreadCount : null, source: mail?.source || null,
    syncedAt: mail?.syncedAt || null, error: mail?.error || null,
    stale: !known || !!mail?.error || !mail?.syncedAt || now - mail.syncedAt > 10 * 60_000 };
}

export async function syncUnread(env, fetcher = fetch) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.FEISHU_MAILBOX) throw new Error('飞书云端同步尚未配置');
  const previous = await env.EINK_KV.get('mail', { type: 'json' });
  const now = Date.now();
  async function request(path, init = {}) {
    const response = await fetcher(API + path, { ...init, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('飞书请求失败');
    const body = await response.json();
    if (body.code !== 0) throw new Error('飞书权限或接口暂不可用');
    return body;
  }
  try {
    const auth = await request('/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
    });
    if (!auth.tenant_access_token) throw new Error('飞书认证失败');
    // Only enumerate unread IDs. Never request subjects, senders, bodies or attachments.
    const ids = new Set(), pages = new Set();
    let pageToken;
    for (let page = 0; page < 100; page++) {
      const params = new URLSearchParams({ folder_id: 'INBOX', only_unread: 'true', page_size: '20' });
      if (pageToken) params.set('page_token', pageToken);
      const result = await request(`/mail/v1/user_mailboxes/${encodeURIComponent(env.FEISHU_MAILBOX)}/messages?${params}`, {
        headers: { Authorization: `Bearer ${auth.tenant_access_token}` },
      });
      if (!Array.isArray(result.data?.items) || typeof result.data.has_more !== 'boolean') throw new Error('飞书响应格式异常');
      for (const item of result.data.items) {
        const id = typeof item === 'string' ? item : item?.message_id || item?.id;
        if (typeof id !== 'string' || !id) throw new Error('飞书响应格式异常');
        ids.add(id);
      }
      if (!result.data.has_more) {
        const mail = { unreadCount: ids.size, source: 'feishu-inbox', syncedAt: now, error: null };
        // Refresh the snapshot periodically, without writing KV on every unchanged poll.
        if (previous?.unreadCount !== mail.unreadCount || previous?.error || previous?.source !== mail.source ||
            now - (previous?.syncedAt || 0) >= 5 * 60_000) await env.EINK_KV.put('mail', JSON.stringify(mail));
        return mailStatus(mail, now);
      }
      pageToken = result.data.page_token;
      if (!pageToken || pages.has(pageToken)) throw new Error('飞书分页异常');
      pages.add(pageToken);
    }
    throw new Error('未读邮件过多，未完成统计');
  } catch {
    const mail = { unreadCount: Number.isSafeInteger(previous?.unreadCount) ? previous.unreadCount : null,
      source: 'feishu-inbox', syncedAt: previous?.syncedAt || null, error: '邮件同步暂时失败', attemptedAt: now };
    if (!previous?.error || now - (previous?.attemptedAt || 0) >= 5 * 60_000) await env.EINK_KV.put('mail', JSON.stringify(mail));
    throw new Error('邮件同步失败，保留上次数量；请检查飞书应用权限和凭据');
  }
}
