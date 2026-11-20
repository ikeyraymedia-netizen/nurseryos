/** Card processing fee in cents. Percent is the invoice setting, such as 3 for 3%. */
export function cardFeeCents(balanceCents: number, percent: number): number {
  if (!Number.isFinite(balanceCents) || balanceCents <= 0) return 0;
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.round((balanceCents * percent) / 100);
}

/** Blank or out of range means no card fee. Allowed range is 0.1% to 10%. */
export function normalizeCardFeePercent(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const rounded = Math.round(value * 100) / 100;
  if (rounded < 0.1 || rounded > 10) return null;
  return rounded;
}

/**
 * Card-fee checkout is only live for the Bayou State owner while it is being tested.
 * Other nurseries keep the combined card and bank pay link.
 */
export function cardFeePilotTenant(tenant: {
  id?: string | null;
  name?: string | null;
  publicAvailabilitySlug?: string | null;
} | null | undefined): boolean {
  if (!tenant) return false;
  if (tenant.id === 'bayou-state-plant-co-2805ux') return true;
  const slug = String(tenant.publicAvailabilitySlug || '').trim().toLowerCase();
  if (slug === 'bayou-state') return true;
  const name = String(tenant.name || '').trim().toLowerCase();
  return name === 'bayou state plant co' || name.startsWith('bayou state');
}

export function cardPaymentsEnabled(
  enabled: boolean | undefined,
  cardFeePercent: number | null | undefined
): boolean {
  return Boolean(enabled) && normalizeCardFeePercent(cardFeePercent) != null;
}
