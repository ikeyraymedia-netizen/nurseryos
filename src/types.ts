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
  | 'profit'
  | 'payments';

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
   * Omit/undefined = legacy (all standard modules on; vendors/profit stay off).
   * `[]` = nothing enabled (new signups until activated in seller console).
   */
  modules?: TenantModuleId[];
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
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName?: string;
  activeTenantId: string | null;
  createdAt: string;
  /** Platform operator — can manage modules for any nursery. Set in Firestore. */
  isPlatformAdmin?: boolean;
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
  inventoryDeductedQty?: number; // Qty removed from live inventory after confirmed sync
  inventorySyncConfirmed?: boolean; // True only after inventory write succeeded
  pulledQuantity?: number; // To track pulled/delivered progress
  notes?: string;
  isAddition?: boolean; // Tag for items added to an existing order
  /** ISO timestamp when this line was added to an existing order (for activity alerts) */
  addedAt?: string;
  unitPrice?: number; // Optional price per plant item for invoices
  unitCost?: number; // Our cost per plant (for profit tracking; internal only)
  vendor?: string; // Vendor name/id we are buying this plant from
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
  emailSentAt?: string; // Timestamp of when the last invoice was emailed
  stagedLocation?: string; // Where this order is staged out
  owner?: string; // Sales rep this order/invoice is credited to
}

export interface Customer {
  id: string;
  name: string;
  contactEmail?: string;
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

export type CustomerDocumentType = 'estimate' | 'invoice';

export interface CustomerDocumentLineItem {
  id: string;
  plantName: string;
  containerSize: string;
  quantity: number;
  unitPrice: number;
  unitCost?: number; // Our cost per plant (internal profit tracking; never shown to customer)
  notes?: string;
}

/** Estimate or invoice saved under a customer record. */
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
  paymentTerms?: string;
  taxRate?: number;
  freightCharge?: number;
  freightAllocation?: FreightAllocation;
  discount?: number;
  notes?: string;
  billToName: string;
  billToAddress?: string;
  customerEmail?: string;
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
  /** Stripe Connect payment collection status for this invoice. */
  paymentStatus?: 'unpaid' | 'pending' | 'paid' | 'failed';
  paidAt?: string;
  stripeCheckoutSessionId?: string;
  stripeCheckoutUrl?: string;
  stripePaymentIntentId?: string;
  stripePaidAmountCents?: number;
  /** Connected account id used when the pay link was created (direct or destination). */
  stripeConnectedAccountId?: string;
  createdAt: string;
  updatedAt: string;
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
  owner?: string; // Who the truck is for: "Ikey" | "Nathan" | "Michael"
  loadingDate?: string; // The date when the truck is scheduled to be loaded
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

export interface InventoryPlant {
  id: string;
  plantName: string;
  containerSize: string;
  quantityAvailable: number;
  weeksUntilReady?: number | null;
  chemicals: ChemicalApplication[];
  cutBackAt?: string | null;
  cutBackNotes?: string;
  location?: string;
  /** Catalog section e.g. Shrubs, Ground Cover, Grasses */
  category?: string;
  /** List / wholesale price from catalog import */
  listPrice?: number | null;
  notes?: string;
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
