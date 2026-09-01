import admin from 'firebase-admin';
import {
  getAdminDb,
  hasAnyRole,
  MemberRoleName,
  normalizeRoles
} from './firebaseAdmin';

export type PushEventType =
  | 'invoice_paid'
  | 'order_uploaded'
  | 'truck_built'
  | 'task_assigned'
  | 'plant_added';

const RECIPIENT_ROLES: Record<Exclude<PushEventType, 'task_assigned'>, MemberRoleName[]> = {
  invoice_paid: ['owner', 'admin', 'office', 'sales'],
  order_uploaded: ['owner', 'admin', 'supervisor', 'office', 'sales', 'loader'],
  truck_built: ['owner', 'admin', 'supervisor', 'loader'],
  plant_added: ['owner', 'admin', 'supervisor', 'loader', 'sales']
};

function appOrigin(): string {
  const raw = process.env.APP_URL?.trim() || 'https://nurseryos.app';
  return raw.replace(/\/+$/, '');
}

function absoluteAppUrl(path = '/'): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${appOrigin()}${p}`;
}

async function collectTokensForUserIds(userIds: string[]): Promise<{
  tokens: string[];
  tokenToUser: Map<string, string>;
}> {
  const db = getAdminDb();
  const tokenToUser = new Map<string, string>();
  const allTokens: string[] = [];
  for (const uid of userIds) {
    const snap = await db.doc(`users/${uid}`).get();
    const fcmTokens = snap.data()?.fcmTokens as
      | Record<string, { token?: string }>
      | undefined;
    if (!fcmTokens) continue;
    for (const entry of Object.values(fcmTokens)) {
      if (!entry?.token) continue;
      tokenToUser.set(entry.token, uid);
      allTokens.push(entry.token);
    }
  }
  return { tokens: [...new Set(allTokens)], tokenToUser };
}

export interface SendTenantPushParams {
  tenantId: string;
  type: PushEventType;
  title: string;
  body: string;
  url?: string;
  /** Required for task_assigned — only this user is notified. */
  targetUserId?: string;
  /** Skip notifying the actor (e.g. person who added the plant). */
  excludeUserId?: string;
}

async function getTenantMemberUserIds(
  tenantId: string,
  roles: MemberRoleName[],
  excludeUserId?: string
): Promise<string[]> {
  const snap = await getAdminDb().collection(`tenants/${tenantId}/members`).get();
  const ids: string[] = [];
  for (const doc of snap.docs) {
    if (excludeUserId && doc.id === excludeUserId) continue;
    const memberRoles = normalizeRoles(doc.data());
    if (hasAnyRole(memberRoles, roles)) ids.push(doc.id);
  }
  return ids;
}

async function removeInvalidTokens(
  tokenToUser: Map<string, string>,
  invalidTokens: string[]
): Promise<void> {
  if (!invalidTokens.length) return;
  const db = getAdminDb();
  const byUser = new Map<string, string[]>();
  for (const token of invalidTokens) {
    const uid = tokenToUser.get(token);
    if (!uid) continue;
    const list = byUser.get(uid) || [];
    list.push(token);
    byUser.set(uid, list);
  }
  for (const [uid, tokens] of byUser) {
    const ref = db.doc(`users/${uid}`);
    const snap = await ref.get();
    const fcmTokens = { ...(snap.data()?.fcmTokens as Record<string, { token: string }> | undefined) };
    if (!fcmTokens) continue;
    let changed = false;
    for (const [key, entry] of Object.entries(fcmTokens)) {
      if (entry?.token && tokens.includes(entry.token)) {
        delete fcmTokens[key];
        changed = true;
      }
    }
    if (changed) {
      await ref.set({ fcmTokens }, { merge: true });
    }
  }
}

export async function sendPushToUserIds(params: {
  userIds: string[];
  title: string;
  body: string;
  url?: string;
  type?: PushEventType;
  tenantId?: string;
}): Promise<{ sent: number; failed: number; tokens: number }> {
  getAdminDb();
  const uniqueIds = [...new Set(params.userIds.filter(Boolean))];
  if (!uniqueIds.length) return { sent: 0, failed: 0, tokens: 0 };

  const { tokens: uniqueTokens, tokenToUser } = await collectTokensForUserIds(uniqueIds);
  if (!uniqueTokens.length) return { sent: 0, failed: 0, tokens: 0 };

  const url = params.url || '/';
  const origin = appOrigin();
  const icon = `${origin}/favicon.png`;
  const messaging = admin.messaging();
  const res = await messaging.sendEachForMulticast({
    tokens: uniqueTokens,
    data: {
      title: params.title,
      body: params.body,
      url,
      type: params.type || 'plant_added',
      tenantId: params.tenantId || ''
    },
    webpush: {
      notification: {
        title: params.title,
        body: params.body,
        icon,
        badge: icon
      },
      fcmOptions: {
        link: absoluteAppUrl(url)
      }
    }
  });

  let sent = 0;
  let failed = 0;
  const invalid: string[] = [];
  res.responses.forEach((r, i) => {
    if (r.success) {
      sent += 1;
      return;
    }
    failed += 1;
    const code = (r.error as { code?: string } | undefined)?.code;
    console.warn('[push] send failed', uniqueTokens[i]?.slice(0, 12), code, r.error?.message);
    if (
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/registration-token-not-registered'
    ) {
      invalid.push(uniqueTokens[i]);
    }
  });

  if (invalid.length) {
    await removeInvalidTokens(tokenToUser, invalid);
  }

  console.log('[push] delivered', { sent, failed, tokens: uniqueTokens.length, title: params.title });
  return { sent, failed, tokens: uniqueTokens.length };
}

export async function sendTenantPush(params: SendTenantPushParams): Promise<void> {
  getAdminDb();

  let userIds: string[];
  if (params.type === 'task_assigned') {
    if (!params.targetUserId) {
      console.warn('[push] task_assigned missing targetUserId');
      return;
    }
    userIds =
      params.excludeUserId && params.targetUserId === params.excludeUserId
        ? []
        : [params.targetUserId];
  } else {
    userIds = await getTenantMemberUserIds(
      params.tenantId,
      RECIPIENT_ROLES[params.type],
      params.excludeUserId
    );
  }

  if (!userIds.length) return;

  await sendPushToUserIds({
    userIds,
    title: params.title,
    body: params.body,
    url: params.url,
    type: params.type,
    tenantId: params.tenantId
  });
}
