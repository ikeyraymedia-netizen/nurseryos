/** Card-funded payments over this amount (cents) must confirm goods were received. */
export const MELIO_CARD_GOODS_CENTS = 300_000;

export interface MelioMerchantAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
}

export interface MelioPaymentCompliance {
  type: 'goods-and-services';
  goodsReceived?: true;
  card?: {
    merchantCategoryCode: string;
    merchantAddress: MelioMerchantAddress;
  };
}

export function requireMelioSonarToken(token: unknown): string {
  const value = String(token || '').trim();
  if (!value) {
    throw Object.assign(
      new Error('Melio Sonar is required for this step. Refresh the page and try again.'),
      { status: 400 }
    );
  }
  return value;
}

function clean(value: unknown): string {
  return String(value || '').trim();
}

function merchantAddress(input: unknown): MelioMerchantAddress {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const line1 = clean(raw.line1);
  const line2 = clean(raw.line2);
  const city = clean(raw.city);
  const state = clean(raw.state).toUpperCase();
  const postal = clean(raw.postalCode).replace(/[^\d-]/g, '');
  if (!line1 || !city || !/^[A-Z]{2}$/.test(state) || !/^\d{5}(-\d{4})?$/.test(postal)) {
    throw Object.assign(
      new Error('Enter the vendor’s business street, city, state, and ZIP for a card payment.'),
      { status: 400 }
    );
  }
  return {
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    state,
    postalCode: postal
  };
}

/**
 * Compliance object for POST /payments.
 * Bank payments send only the transfer purpose. Card payments also send the
 * vendor’s category and business address. Amounts above $3,000 on a card
 * require the goods-received confirmation.
 */
export function buildMelioPaymentCompliance(input: {
  fundingType?: string | null;
  amountCents: number;
  merchantCategoryCode?: unknown;
  goodsReceived?: boolean;
  merchantAddress?: unknown;
}): MelioPaymentCompliance {
  if (String(input.fundingType || '').toLowerCase() !== 'card') {
    return { type: 'goods-and-services' };
  }
  const merchantCategoryCode = clean(input.merchantCategoryCode);
  if (!/^\d{4}$/.test(merchantCategoryCode)) {
    throw Object.assign(
      new Error('Enter the vendor’s 4-digit category code for a card payment.'),
      { status: 400 }
    );
  }
  const address = merchantAddress(input.merchantAddress);
  const compliance: MelioPaymentCompliance = {
    type: 'goods-and-services',
    card: { merchantCategoryCode, merchantAddress: address }
  };
  if (input.amountCents > MELIO_CARD_GOODS_CENTS) {
    if (input.goodsReceived !== true) {
      throw Object.assign(
        new Error('Confirm the goods or services were received before this card payment.'),
        { status: 400 }
      );
    }
    compliance.goodsReceived = true;
  }
  return compliance;
}
