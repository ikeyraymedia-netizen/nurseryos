export type MemberRole = 'owner' | 'admin' | 'supervisor' | 'office' | 'sales' | 'loader' | 'inventory';

/** Workspace / feature modules toggled per nursery in the seller console. */
export type TenantModuleId =
  | 'orders'
  | 'trucks'
  | 'customers'
  | 'inventory'
  | 'invoicing'
  | 'reports'
  | 'tasks'
  | 'bol'
  | 'vendors'
  | 'textVendors'
  | 'profit'
  | 'payments'
  | 'quickbooks'
  | 'purchasing'
  | 'billPay';

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
  ownerId: string;
  /** Ship-from / origin address shown on invoices and bills of lading. */
  shippingAddress?: string;
  /** Optional nursery logo URL (HTTPS or data URL) for BOL/invoice headers. */
  logoUrl?: string;
  /**
   * Enabled workspace modules for this nursery.
   * Omit/undefined = legacy (all standard modules on; opt-in add-ons stay off).
   * `[]` = nothing enabled (new signups until activated in seller console).
   */
  modules?: TenantModuleId[];
  /** When true, `/a/:slug` and the public JSON API are live. */
  publicAvailabilityEnabled?: boolean;
  /** URL slug for public availability, e.g. bayou-state → /a/bayou-state */
  publicAvailabilitySlug?: string;
  /** Include qty on the public availability page/API. Default true. */
  publicAvailabilityShowQty?: boolean;
  /** Include photos on the public availability page/API. Default true. */
  publicAvailabilityShowPhotos?: boolean;
  /** When show qty is on, only list plants with qty > 0. Default false. */
  publicAvailabilityInStockOnly?: boolean;
}

export interface TenantMember {
  userId: string;
  email: string;
  /** Highest-privilege role (legacy + primary). Prefer `roles` when present. */
  role: MemberRole;
  /** All assigned roles. A member can be both inventory and loader, etc. */
  roles?: MemberRole[];
  displayName?: string;
  joinedAt: string;
  /** Present during invite redemption so Firestore rules can validate the code. */
  inviteCode?: string;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string;
  activeTenantId: string | null;
  createdAt: string;
  /** UI language preference (`en` default). */
  locale?: 'en' | 'es';
  /** Platform operator — can manage modules for any nursery. Set in Firestore. */
  isPlatformAdmin?: boolean;
  /** Web push tokens keyed by device id. */
  fcmTokens?: Record<
    string,
    {
      token: string;
      updatedAt: string;
      userAgent?: string;
    }
  >;
}

export interface ContainerWeight {
  id: string; // e.g. "1_gallon", "3_gallon", etc.
  name: string; // e.g. "#1 / 1-Gallon Pot"
  label: string; // e.g. "#1", "1G", "1-Gallon" (comma separated search aliases or a clean visual key)
  weightLbs: number;
}

export interface PlantOrderItem {
  id: string;
  plantName: string;
  containerSize: string; // The recognized size string (e.g., "#3", "#15")
  quantity: number;
  loadedQuantity: number; // For loaders to track loading progress
  /** Qty already saved on one or more invoices for this order line. */
  invoicedQuantity?: number;
  inventoryDeductedQty?: number; // Qty removed from live inventory after confirmed sync
  inventorySyncConfirmed?: boolean; // True only after inventory write succeeded
  pulledQuantity?: number; // To track pulled/delivered progress
  notes?: string;
  /** Possible substitute plant material (shown on estimates). Free text, e.g. "Boxwood, Holly". */
  substitutes?: string;
  /** Estimate-only: plant cannot be supplied; shown grayed / not in totals. */
  unavailable?: boolean;
  /** Estimate-only: include a clickable inventory photo link for the customer. */
  includePhotoLink?: boolean;
  /** Snapshot of inventory photo URL when includePhotoLink is on. */
  photoUrl?: string | null;
  isAddition?: boolean; // Tag for items added to an existing order
  /** ISO timestamp when this line was added to an existing order (for activity alerts) */
  addedAt?: string;
  unitPrice?: number; // Optional price per plant item for invoices
  unitCost?: number; // Our cost per plant (for profit tracking; internal only)
  /** Quoted / supply vendor — internal (estimates, purchasing memory); never on customer PDF/email. */
  vendor?: string;
}

export interface InvoiceDetails {
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  poNumber?: string; // Customer purchase order number
  paymentTerms?: string;
  taxRate?: number; // sales tax percentage, e.g. 4.45
  freightCharge?: number; // delivery / freight charge
  freightAllocation?: FreightAllocation;
  discount?: number; // flat discount amount
  notes?: string; // custom terms/invoice notes
}

export interface FreightAllocation {
  truckId: string;
  totalFreight: number;
  method: 'equal' | 'truckUsage';
  allocatedAt: string;
}

export interface CustomerOrder {
  id: string;
  customerName: string;
  customerId?: string;
  orderNumber: string;
  dateCreated: string; // ISO string
  items: PlantOrderItem[];
  originalText: string; // The plain text format extracted from the PDF/image
  status: 'pending' | 'loading' | 'completed';
  totalWeightLbs: number;
  truckId?: string | null; // ID of the truck this order is assigned to
  invoiceDetails?: InvoiceDetails; // Optional saved invoice customization
  customerEmail?: string; // Contact email for invoicing
  /** Comma-separated CC list remembered from the last send. */
  customerEmailCc?: string;
  emailSentAt?: string; // Timestamp of when the last invoice was emailed
  stagedLocation?: string; // Where this order is staged out
  owner?: string; // Sales rep this order/invoice is credited to
  /** Vendor ships straight to customer — hidden from yard roles (owner/admin only). */
  directShip?: boolean;
}

export interface Customer {
  id: string;
  name: string;
  contactEmail?: string;
  /** Optional CC list for invoices, estimates, and statements. */
  contactEmailCc?: string;
  phone?: string;
  /** Bill-to company / person name (defaults to `name` when empty). */
  billingName?: string;
  billingAddress?: string;
  /** Ship-to company / person name (defaults to `name` when empty). */
  shippingName?: string;
  shippingAddress?: string;
  /** @deprecated Prefer shippingAddress; kept for older records. */
  receiverAddress?: string;
  pointOfContact?: string;
  paymentTerms?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type CustomerDocumentType = 'estimate' | 'invoice' | 'credit_memo';

/** How a customer invoice or vendor bill was paid (offline / recorded). */
export type PaymentMethod = 'check' | 'ach' | 'wire' | 'cc' | 'stripe' | 'quickbooks';

export interface CustomerDocumentLineItem {
  id: string;
  plantName: string;
  containerSize: string;
  quantity: number;
  unitPrice: number;
  unitCost?: number; // Our cost per plant (internal profit tracking; never shown to customer)
  notes?: string;
  /** Possible substitute plant material — mainly for estimates. */
  substitutes?: string;
  /** Estimate-only: plant cannot be supplied; shown grayed / not in totals. */
  unavailable?: boolean;
  /** Estimate-only: include a clickable inventory photo link for the customer. */
  includePhotoLink?: boolean;
  /** Snapshot of inventory photo URL when includePhotoLink is on. */
  photoUrl?: string | null;
  /** Quoted source vendor — estimates/internal only; never on customer PDF/email. */
  vendor?: string;
}

/** Estimate, invoice, or credit memo saved under a customer record. */
export interface CustomerDocument {
  id: string;
  customerId: string;
  customerName: string;
  orderId?: string;
  orderNumber?: string;
  type: CustomerDocumentType;
  documentNumber: string;
  documentDate: string;
  dueDate?: string;
  poNumber?: string; // Customer purchase order number
  /** Invoice number this credit memo applies to (credit memos). */
  referencedInvoiceNumber?: string;
  paymentTerms?: string;
  taxRate?: number;
  freightCharge?: number;
  freightAllocation?: FreightAllocation;
  discount?: number;
  notes?: string;
  billToName: string;
  billToAddress?: string;
  customerEmail?: string;
  /** Comma-separated CC list for this document’s email. */
  customerEmailCc?: string;
  owner?: string; // Sales rep credited for this invoice/estimate
  items: CustomerDocumentLineItem[];
  subtotal: number;
  salesTax: number;
  grandTotal: number;
  emailSentAt?: string;
  /** QuickBooks Online invoice/estimate id after sync. */
  qboInvoiceId?: string;
  qboDocType?: CustomerDocumentType;
  qboSyncedAt?: string;
  qboSyncedByUserId?: string;
  /** Hosted Intuit pay URL for this invoice (when QBO Payments is enabled). */
  qboInvoiceLink?: string;
  /** Deep link to open the txn in the QuickBooks UI. */
  qboOpenUrl?: string;
  qboDocNumber?: string;
  /** QuickBooks Receive Payment id after payment sync. */
  qboPaymentId?: string;
  qboPaymentSyncedAt?: string;
  qboPaymentSyncedByUserId?: string;
  qboPaymentNote?: string | null;
  /** Stripe Connect payment collection status for this invoice. */
  paymentStatus?: 'unpaid' | 'pending' | 'paid' | 'failed';
  paidAt?: string;
  /** How the invoice was paid (manual entry or Stripe). */
  paymentMethod?: PaymentMethod;
  /** Check number or ACH/Wire/CC confirmation / reference. */
  paymentReference?: string;
  stripeCheckoutSessionId?: string;
  stripeCheckoutUrl?: string;
  stripePaymentIntentId?: string;
  stripePaidAmountCents?: number;
  /** Connected account id used when the pay link was created (direct or destination). */
  stripeConnectedAccountId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Saved BOL form fields so addresses survive closing the modal. */
export interface TruckBolDraft {
  shipperAddress?: string;
  shipDate?: string;
  driverName?: string;
  truckNumber?: string;
  trailerNumber?: string;
  sealNumber?: string;
  /** @deprecated Prefer receiverContacts keyed by stop; kept for older drafts. */
  receiverContact?: string;
  specialInstructions?: string;
  blindBol?: boolean;
  /** Last selected BOL type: 'consolidated' or an order id. */
  selectedBOLType?: string;
  /** Receiver address keyed by 'consolidated' or order id. */
  receiverAddresses?: Record<string, string>;
  /** Point of contact keyed by 'consolidated' or order id. */
  receiverContacts?: Record<string, string>;
  /** Customer PO # keyed by 'consolidated' or order id. */
  poNumbers?: Record<string, string>;
  updatedAt?: string;
}

export interface Truck {
  id: string;
  name: string; // e.g. "Truck A - Lafayette Delivery"
  carrier?: string; // e.g. "Cajun Freight"
  truckType?: string; // e.g. "Gooseneck", "26' Box", etc.
  notes?: string; // e.g. "Load large items first"
  dateCreated: string; // ISO string
  status: 'pending' | 'loading' | 'completed';
  orderIds: string[]; // List of order IDs assigned to this truck
  owner?: string; // Sales rep this truck is credited to

  loadingDate?: string; // The date when the truck is scheduled to be loaded
  /** ISO time of first plant loaded on this truck (admin load-duration timer). */
  loadingStartedAt?: string;
  /** ISO time of most recent plant load increase (last plant when truck is 100%). */
  loadingFinishedAt?: string;
  /** Draft BOL form (addresses, driver, etc.) saved from the BOL modal. */
  bolDraft?: TruckBolDraft;
}

export interface TenantInvite {
  id: string;
  code: string;
  /** Primary role for legacy invite codes. */
  role: Exclude<MemberRole, 'owner'>;
  /** Roles granted when the invite is redeemed. */
  roles?: Exclude<MemberRole, 'owner'>[];
  tenantId: string;
  tenantName: string;
  createdBy: string;
  createdAt: string;
  active: boolean;
}

export interface ChemicalApplication {
  chemicalName: string;
  appliedAt: string; // ISO date
  notes?: string;
}

export interface FertilizerApplication {
  fertilizerName: string;
  appliedAt: string; // ISO date
  notes?: string;
}

export interface InventoryPlant {
  id: string;
  plantName: string;
  containerSize: string;
  quantityAvailable: number;
  /** Local calendar date YYYY-MM-DD when planted / potted up. */
  plantedDate?: string | null;
  /** Local calendar date YYYY-MM-DD when expected ready to sell/load. */
  readyDate?: string | null;
  chemicals: ChemicalApplication[];
  fertilizers?: FertilizerApplication[];
  cutBackAt?: string | null;
  cutBackNotes?: string;
  location?: string;
  /** Catalog section e.g. Shrubs, Ground Cover, Grasses */
  category?: string;
  /** List / wholesale price from catalog import */
  listPrice?: number | null;
  /** Where these plants/liners were purchased from (vendor or custom grower). */
  sourceVendorId?: string | null;
  sourceName?: string;
  notes?: string;
  /** Public HTTPS URL for plant photo (Firebase Storage). */
  photoUrl?: string | null;
  /** Storage object path for delete/replace. */
  photoPath?: string | null;
  dateCreated: string;
  dateUpdated: string;
}

export interface NurseryTask {
  id: string;
  title: string;
  notes?: string;
  /** Local calendar date YYYY-MM-DD */
  dueDate: string;
  assigneeUserId: string;
  assigneeName: string;
  assigneeEmail?: string;
  createdByUserId: string;
  createdByName: string;
  completed: boolean;
  completedAt?: string | null;
  completedByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Wholesale grower / supplier the nursery buys from. */
export interface Vendor {
  id: string;
  name: string;
  contactEmail?: string;
  /** Optional CC list when emailing purchase orders. */
  contactEmailCc?: string;
  phone?: string;
  contactName?: string;
  billingAddress?: string;
  paymentTerms?: string;
  notes?: string;
  /** Bank/card merchant strings that map to this vendor (learned from feed tagging). */
  merchantAliases?: string[];
  /** ACH destination for Stripe Treasury vendor pay (owner/admin only). */
  bankRoutingNumber?: string;
  /** Full account number — required to send ACH; never shown in full after save. */
  bankAccountNumber?: string;
  bankAccountLast4?: string;
  bankAccountHolderName?: string;
  bankAccountType?: 'checking' | 'savings';
  /** QuickBooks Online Vendor id after AP sync. */
  qboVendorId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PurchaseOrderStatus =
  | 'draft'
  | 'sent'
  | 'partial'
  | 'received'
  | 'cancelled';

export interface PurchaseOrderLine {
  id: string;
  plantName: string;
  containerSize: string;
  quantityOrdered: number;
  /** Cumulative qty received into inventory. */
  quantityReceived: number;
  unitCost: number;
  notes?: string;
}

/** Outbound purchase order to a vendor. */
export interface PurchaseOrder {
  id: string;
  vendorId: string;
  vendorName: string;
  poNumber: string;
  status: PurchaseOrderStatus;
  orderDate: string;
  expectedDate?: string;
  notes?: string;
  items: PurchaseOrderLine[];
  subtotal: number;
  freightCharge?: number;
  grandTotal: number;
  createdAt: string;
  updatedAt: string;
}

export type VendorBillStatus = 'unpaid' | 'payment_pending' | 'paid';

/**
 * Optional legacy field from an earlier dual type/category model.
 * New bills use `category` only (preset or custom free text).
 */
export type PurchaseLineType = 'plant' | 'supply' | 'freight' | 'other';

export interface VendorBillLine {
  id: string;
  /** Description — plant name or supply description. */
  plantName: string;
  containerSize: string;
  quantity: number;
  unitCost: number;
  /** Spend category — preset label or any custom text the nursery enters. */
  category?: string;
  /** @deprecated Prefer category; kept for older bills. */
  lineType?: PurchaseLineType;
  notes?: string;
}

/** Accounts-payable bill from a vendor (their invoice to us). */
export interface VendorBill {
  id: string;
  vendorId: string;
  vendorName: string;
  billNumber: string;
  /** Vendor's own invoice number from the paper/PDF invoice. */
  vendorInvoiceNumber?: string;
  /** Optional link back to our PO. */
  purchaseOrderId?: string;
  poNumber?: string;
  status: VendorBillStatus;
  billDate: string;
  dueDate?: string;
  notes?: string;
  items: VendorBillLine[];
  subtotal: number;
  freightCharge?: number;
  grandTotal: number;
  /** Scanned invoice image/PDF in Firebase Storage. */
  invoicePhotoUrl?: string | null;
  invoicePhotoPath?: string | null;
  paidAt?: string;
  /** How this vendor bill was paid. */
  paymentMethod?: PaymentMethod;
  /** Check number or ACH/Wire/CC confirmation / reference. */
  paymentReference?: string;
  /** Legacy ACH provider fields (kept for old Firestore docs; no longer written). */
  checkbookPaymentId?: string | null;
  checkbookPaymentStatus?: string | null;
  checkbookPaymentNumber?: number | null;
  checkbookRecipient?: string | null;
  checkbookDepositOption?: string | null;
  checkbookPaymentError?: string | null;
  /** Stripe Treasury OutboundPayment id when paid via ACH bill pay. */
  stripeOutboundPaymentId?: string | null;
  stripeOutboundPaymentStatus?: string | null;
  stripePaymentError?: string | null;
  /** Last4 of vendor bank used for this ACH (display). */
  stripeAchLast4?: string | null;
  /** QuickBooks Online Bill id after AP sync. */
  qboBillId?: string | null;
  qboDocNumber?: string | null;
  qboVendorId?: string | null;
  qboOpenUrl?: string | null;
  qboSyncedAt?: string | null;
  qboSyncedByUserId?: string | null;
  /** QuickBooks BillPayment id after AP payment sync. */
  qboBillPaymentId?: string | null;
  qboBillPaymentSyncedAt?: string | null;
  qboBillPaymentSyncedByUserId?: string | null;
  qboBillPaymentNote?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One plant/size row from a vendor availability / price list upload (Sourcing). */
export interface VendorAvailabilityLine {
  id: string;
  vendorId: string;
  vendorName: string;
  plantName: string;
  containerSize: string;
  quantityAvailable: number;
  listPrice?: number | null;
  location?: string;
  category?: string;
  notes?: string;
  sourceFileName?: string;
  importBatchId: string;
  importedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Bank or credit-card line imported from CSV for expense tagging. */
export type BankFeedStatus = 'unreviewed' | 'tagged' | 'ignored';

export type BankFeedAccountKind = 'bank' | 'card';

export interface BankFeedTransaction {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  description: string;
  /** Cleaned payee / merchant hint when available. */
  merchant?: string;
  /**
   * Signed amount in USD.
   * Negative = money out (expense). Positive = money in (deposit / card payment credit).
   */
  amount: number;
  accountKind: BankFeedAccountKind;
  accountLabel?: string;
  source: 'csv';
  importBatchId: string;
  /** Dedupe key: date|amount|normalized description */
  fingerprint: string;
  status: BankFeedStatus;
  vendorId?: string | null;
  vendorName?: string | null;
  category?: string | null;
  vendorBillId?: string | null;
  matchConfidence?: 'exact' | 'fuzzy' | 'none' | 'manual';
  createdAt: string;
  updatedAt: string;
}
