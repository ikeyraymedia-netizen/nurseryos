import type { Express, Request, Response } from 'express';
import {
  getAdminDb,
  getMemberRoles,
  hasAnyRole,
  isFirebaseAdminConfigured,
  verifyFirebaseIdToken
} from './firebaseAdmin';

type PublicPlant = {
  id: string;
  plantName: string;
  containerSize: string;
  category: string | null;
  quantityAvailable?: number;
  listPrice: number | null;
  readyDate: string | null;
  photoUrl: string | null;
};

type PublicAvailabilityPayload = {
  nurseryName: string;
  logoUrl: string | null;
  shippingAddress: string | null;
  slug: string;
  showQty: boolean;
  showPhotos: boolean;
  updatedAt: string;
  plants: PublicPlant[];
};

function slugRef(slug: string) {
  return getAdminDb().doc(`publicSlugs/${slug}`);
}

export function normalizePublicSlug(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function isValidPublicSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(slug) || /^[a-z0-9]{2,48}$/.test(slug);
}

async function readBearerUid(req: Request): Promise<string> {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw Object.assign(new Error('Sign in required.'), { status: 401 });
  }
  const decoded = await verifyFirebaseIdToken(match[1].trim());
  return decoded.uid;
}

async function assertCanManagePublicAvailability(tenantId: string, uid: string) {
  const roles = await getMemberRoles(tenantId, uid);
  if (!hasAnyRole(roles, ['owner', 'admin'])) {
    throw Object.assign(new Error('Only owners and admins can manage public availability.'), {
      status: 403
    });
  }
}

function handleAsync(res: Response, fn: () => Promise<void>) {
  void fn().catch((err: unknown) => {
    const status = Number((err as { status?: number })?.status) || 500;
    const message = err instanceof Error ? err.message : 'Request failed.';
    console.error('[public-availability]', err);
    res.status(status).json({ error: message });
  });
}

function categoryLabel(raw?: string | null): string | null {
  const v = String(raw || '').trim();
  return v || null;
}

function isSizeDerivedCategory(raw?: string | null): boolean {
  const v = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!v) return false;
  if (v === 'b&b' || v === 'b and b' || v === 'flats' || v === 'caliper' || v === 'tray') {
    return true;
  }
  if (/^#?\d+(\.\d+)?$/.test(v)) return true;
  if (/^\d+(\.\d+)?\s*(gal|gallon|gallons|g)$/.test(v)) return true;
  if (/^#\d+(\.\d+)?\s*(gal|gallon|gallons|g)?$/.test(v)) return true;
  return false;
}

/** Prefer entered section/category; ignore gallon/size auto-labels. */
function publicCategoryLabel(raw?: string | null): string | null {
  const v = categoryLabel(raw);
  if (!v || isSizeDerivedCategory(v)) return null;
  return v;
}

async function buildPublicPayload(tenantId: string): Promise<PublicAvailabilityPayload | null> {
  const tenantSnap = await getAdminDb().doc(`tenants/${tenantId}`).get();
  if (!tenantSnap.exists) return null;
  const tenant = tenantSnap.data() as {
    name?: string;
    logoUrl?: string | null;
    shippingAddress?: string | null;
    publicAvailabilityEnabled?: boolean;
    publicAvailabilitySlug?: string;
    publicAvailabilityShowQty?: boolean;
    publicAvailabilityShowPhotos?: boolean;
    publicAvailabilityInStockOnly?: boolean;
  };

  if (!tenant.publicAvailabilityEnabled) return null;
  const slug = normalizePublicSlug(tenant.publicAvailabilitySlug || '');
  if (!slug) return null;

  const showQty = tenant.publicAvailabilityShowQty !== false;
  const showPhotos = tenant.publicAvailabilityShowPhotos !== false;
  const inStockOnly = showQty && tenant.publicAvailabilityInStockOnly === true;

  const invSnap = await getAdminDb().collection(`tenants/${tenantId}/inventory`).get();
  const plants: PublicPlant[] = [];
  let latestUpdate = '';

  invSnap.forEach((docSnap) => {
    const data = docSnap.data() as {
      plantName?: string;
      containerSize?: string;
      category?: string | null;
      quantityAvailable?: number;
      listPrice?: number | null;
      readyDate?: string | null;
      photoUrl?: string | null;
      dateUpdated?: string;
      dateCreated?: string;
    };
    const qty = Number(data.quantityAvailable || 0);
    if (inStockOnly && !(qty > 0)) return;
    const updated = String(data.dateUpdated || data.dateCreated || '');
    if (updated && updated > latestUpdate) latestUpdate = updated;

    plants.push({
      id: docSnap.id,
      plantName: String(data.plantName || '').trim() || 'Plant',
      containerSize: String(data.containerSize || '').trim(),
      category: publicCategoryLabel(data.category),
      ...(showQty ? { quantityAvailable: qty } : {}),
      listPrice:
        data.listPrice != null && Number.isFinite(Number(data.listPrice))
          ? Number(data.listPrice)
          : null,
      readyDate: String(data.readyDate || '').trim() || null,
      photoUrl: showPhotos && data.photoUrl ? String(data.photoUrl) : null
    });
  });

  plants.sort((a, b) => {
    const aCat = a.category || 'Uncategorized';
    const bCat = b.category || 'Uncategorized';
    const aUncat = !a.category;
    const bUncat = !b.category;
    if (aUncat && !bUncat) return 1;
    if (!aUncat && bUncat) return -1;
    const cat = aCat.localeCompare(bCat, undefined, { sensitivity: 'base' });
    if (cat !== 0) return cat;
    const name = a.plantName.localeCompare(b.plantName, undefined, { sensitivity: 'base' });
    if (name !== 0) return name;
    return a.containerSize.localeCompare(b.containerSize, undefined, {
      sensitivity: 'base',
      numeric: true
    });
  });

  return {
    nurseryName: String(tenant.name || 'Nursery'),
    logoUrl: tenant.logoUrl?.trim() || null,
    shippingAddress: tenant.shippingAddress?.trim() || null,
    slug,
    showQty,
    showPhotos,
    updatedAt: latestUpdate || new Date().toISOString(),
    plants
  };
}

export function registerPublicAvailabilityRoutes(app: Express) {
  app.get('/api/public/availability/:slug', (req, res) =>
    void handleAsync(res, async () => {
      if (!isFirebaseAdminConfigured()) {
        res.status(503).json({ error: 'Public availability is not configured on the server.' });
        return;
      }
      const slug = normalizePublicSlug(req.params.slug || '');
      if (!isValidPublicSlug(slug)) {
        res.status(400).json({ error: 'Invalid availability link.' });
        return;
      }

      const mapSnap = await slugRef(slug).get();
      if (!mapSnap.exists) {
        res.status(404).json({ error: 'Availability list not found.' });
        return;
      }
      const tenantId = String((mapSnap.data() as { tenantId?: string }).tenantId || '').trim();
      if (!tenantId) {
        res.status(404).json({ error: 'Availability list not found.' });
        return;
      }

      const payload = await buildPublicPayload(tenantId);
      if (!payload || payload.slug !== slug) {
        res.status(404).json({ error: 'Availability list is not published.' });
        return;
      }

      res.setHeader('Cache-Control', 'public, max-age=60');
      res.json(payload);
    })
  );

  app.post('/api/public/availability/settings', (req, res) =>
    void handleAsync(res, async () => {
      if (!isFirebaseAdminConfigured()) {
        res.status(503).json({ error: 'Public availability is not configured on the server.' });
        return;
      }

      const tenantId = String(req.body?.tenantId || '').trim();
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId is required.' });
        return;
      }

      const uid = await readBearerUid(req);
      await assertCanManagePublicAvailability(tenantId, uid);

      const enabled = Boolean(req.body?.enabled);
      const showQty = req.body?.showQty !== false;
      const showPhotos = req.body?.showPhotos !== false;
      const inStockOnly = Boolean(req.body?.inStockOnly);
      const slug = normalizePublicSlug(req.body?.slug || '');

      if (enabled && !isValidPublicSlug(slug)) {
        res.status(400).json({
          error: 'Choose a URL slug with 2–48 letters, numbers, or hyphens (e.g. bayou-state).'
        });
        return;
      }

      const tenantRef = getAdminDb().doc(`tenants/${tenantId}`);
      const tenantSnap = await tenantRef.get();
      if (!tenantSnap.exists) {
        res.status(404).json({ error: 'Nursery not found.' });
        return;
      }
      const existing = tenantSnap.data() as { publicAvailabilitySlug?: string };
      const previousSlug = normalizePublicSlug(existing.publicAvailabilitySlug || '');

      if (enabled) {
        const mapSnap = await slugRef(slug).get();
        if (mapSnap.exists) {
          const owner = String((mapSnap.data() as { tenantId?: string }).tenantId || '');
          if (owner && owner !== tenantId) {
            res.status(409).json({
              error: 'That public link is already used by another nursery. Try a different slug.'
            });
            return;
          }
        }
      }

      const batch = getAdminDb().batch();
      batch.set(
        tenantRef,
        {
          publicAvailabilityEnabled: enabled,
          publicAvailabilitySlug: enabled ? slug : previousSlug || null,
          publicAvailabilityShowQty: showQty,
          publicAvailabilityShowPhotos: showPhotos,
          publicAvailabilityInStockOnly: inStockOnly
        },
        { merge: true }
      );

      if (enabled) {
        batch.set(slugRef(slug), {
          tenantId,
          updatedAt: new Date().toISOString()
        });
        if (previousSlug && previousSlug !== slug) {
          batch.delete(slugRef(previousSlug));
        }
      } else if (previousSlug) {
        batch.delete(slugRef(previousSlug));
      }

      await batch.commit();

      res.json({
        ok: true,
        enabled,
        slug: enabled ? slug : previousSlug || null,
        showQty,
        showPhotos,
        inStockOnly,
        publicPath: enabled ? `/a/${slug}` : null,
        publicApiPath: enabled ? `/api/public/availability/${slug}` : null
      });
    })
  );
}
