import React, { useState, useEffect, useRef } from 'react';
import {
  CustomerOrder,
  PlantOrderItem,
  InvoiceDetails,
  Customer,
  CustomerDocumentType,
  CustomerDocument,
  FreightAllocation,
  InventoryPlant
} from '../types';
import {
  imageSrcToDataUrl,
  resolveNurseryLogoSrc
} from '../lib/nurseryBranding';
import { 
  X, 
  FileText, 
  DollarSign, 
  Percent, 
  Save, 
  Calendar, 
  Landmark, 
  Check, 
  RefreshCw, 
  FileCheck,
  PercentIcon,
  Tag,
  Mail,
  Send,
  AlertTriangle,
  Info,
  Download,
  Link2,
  TrendingUp,
  Plus,
  Trash2,
  Image as ImageIcon,
  Upload
} from 'lucide-react';
import { updateCustomerOrder } from '../lib/db';
import {
  addCustomerDocument,
  updateCustomerDocument,
  deleteCustomerDocument,
  markCustomerInvoicePaid,
  defaultDocumentNumber,
  nextDocumentNumber,
  listAllDocuments,
  subscribeToDocument
} from '../lib/documents';
import { getDefaultPriceForSize } from '../lib/pricing';
import { DEFAULT_VENDORS } from '../data/vendors';
import { subscribeToVendors } from '../lib/vendors';
import { subscribeToInventory } from '../lib/inventory';
import { uploadEstimateLinePhoto } from '../lib/estimatePhotos';
import { useSalesRepOptions } from '../lib/salesReps';
import { logAuditEvent } from '../lib/audit';
import {
  allocateFreight,
  FreightAllocationMethod,
  FreightShare
} from '../lib/freightAllocation';
import { pushDocumentToQuickbooks, pushPaymentToQuickbooks, ensureQboPayLink, refreshQboPaymentStatus } from '../lib/quickbooks';
import { blobToBase64, looksLikeEmail, mailtoUrl, MAX_CC_RECIPIENTS, parseCcEmails, sendInvoiceEmail } from '../lib/email';
import { OutboundReplySelect } from './OutboundReplySelect';
import { EmailCcSection } from './EmailCcSection';
import { createInvoiceCheckout, confirmInvoicePayment, fetchStripeStatus } from '../lib/stripe';
import { deliverPdfBlob } from '../lib/downloadPdf';
import { PdfShareSheet } from './PdfShareSheet';
import { formatPaymentRecord, MarkPaidModal } from './MarkPaidModal';
import jsPDF from 'jspdf';
import { useT } from '../lib/i18n';
import { dueDateFromPaymentTerms } from '../lib/dates';

function isHttpUrl(url: unknown): url is string {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

interface InvoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: CustomerOrder;
  /** Create as estimate or invoice (default invoice). */
  documentType?: CustomerDocumentType;
  /** Linked CRM customer — used for bill-to defaults and saving under the customer. */
  customer?: Customer | null;
  /** Existing saved document to update (from Customers tab). */
  existingDocument?: CustomerDocument | null;
  /** Other orders assigned to the same truck, used for freight allocation. */
  truckOrders?: CustomerOrder[];
  nurseryName?: string;
  /** Ship-from / origin address for the nursery (invoice + BOL). */
  nurseryAddress?: string;
  /** Nursery logo for invoice header / PDF / email (HTTPS or data URL). */
  nurseryLogoSrc?: string | null;
  tenantId?: string;
  /** Enable internal cost/profit tracking (gated by the profit module). */
  canViewProfit?: boolean;
  /** Create Stripe Checkout pay links (gated by payments module). */
  canCollectPayments?: boolean;
  /** Push to QuickBooks Online (gated by quickbooks module). */
  canUseQuickbooks?: boolean;
}

export const InvoiceModal: React.FC<InvoiceModalProps> = ({
  isOpen,
  onClose,
  order,
  documentType: initialDocumentTypeProp = 'invoice',
  customer = null,
  existingDocument = null,
  truckOrders = [],
  nurseryName = 'NurseryOS',
  nurseryAddress = '',
  nurseryLogoSrc = null,
  tenantId,
  canViewProfit = false,
  canCollectPayments = false,
  canUseQuickbooks = false
}) => {
  const initialDocumentType: CustomerDocumentType =
    (initialDocumentTypeProp as CustomerDocumentType) || 'invoice';
  const printRef = useRef<HTMLDivElement | null>(null);
  const logoSrc = nurseryLogoSrc || resolveNurseryLogoSrc(nurseryName);
  const salesRepOptions = useSalesRepOptions(tenantId);
  const t = useT();
  const [documentType, setDocumentType] = useState<CustomerDocumentType>(
    existingDocument?.type || initialDocumentType
  );
  const [savedDocumentId, setSavedDocumentId] = useState<string | null>(
    existingDocument?.id || null
  );
  const documentContextRef = useRef('');
  // State for quantity basis: 'ordered' | 'pulled' | 'loaded'
  const [qtyBasis, setQtyBasis] = useState<'ordered' | 'pulled' | 'loaded'>('ordered');

  // Customer billing details (inline editable)
  const [billToName, setBillToName] = useState(order.customerName);
  const [billToAddress, setBillToAddress] = useState('');

  // Custom invoice properties (saved in invoiceDetails)
  const [invoiceNumber, setInvoiceNumber] = useState(
    existingDocument?.documentNumber ||
      defaultDocumentNumber(initialDocumentType)
  );
  const [poNumber, setPoNumber] = useState('');
  const [referencedInvoiceNumber, setReferencedInvoiceNumber] = useState('');
  /** Editable plant lines for estimates and credit memos. */
  const [creditLines, setCreditLines] = useState<PlantOrderItem[]>([]);
  const [salesRep, setSalesRep] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0]);
  const [paymentTerms, setPaymentTerms] = useState('Net 30');
  const [dueDate, setDueDate] = useState('');
  const [taxRate, setTaxRate] = useState<number>(0);
  const [freightCharge, setFreightCharge] = useState<number>(0);
  const [discount, setDiscount] = useState<number>(0);
  const [invoiceNotes, setInvoiceNotes] = useState(t('invoice.defaultNotesInvoice'));

  // Store editable item prices
  const [itemPrices, setItemPrices] = useState<Record<string, number>>({});
  /** Possible plant substitutes per line (estimate-focused). */
  const [itemSubstitutes, setItemSubstitutes] = useState<Record<string, string>>({});
  // Store editable item costs (internal profit tracking only)
  const [itemCosts, setItemCosts] = useState<Record<string, number>>({});
  /** Inventory plants — used to resolve estimate photo links. */
  const [inventoryPlants, setInventoryPlants] = useState<InventoryPlant[]>([]);
  const [photoUploadBusyId, setPhotoUploadBusyId] = useState<string | null>(null);
  const [photoPickError, setPhotoPickError] = useState<string | null>(null);

  // Database saving status
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showFreightAllocation, setShowFreightAllocation] = useState(false);
  const [isPushingQb, setIsPushingQb] = useState(false);
  const [qbPushMessage, setQbPushMessage] = useState<string | null>(null);
  const [isCreatingPayLink, setIsCreatingPayLink] = useState(false);
  const [payLinkMessage, setPayLinkMessage] = useState<string | null>(null);
  const [payLinkUrl, setPayLinkUrl] = useState<string | null>(
    existingDocument?.qboInvoiceLink || existingDocument?.stripeCheckoutUrl || null
  );
  const [isRefreshingPayment, setIsRefreshingPayment] = useState(false);
  /** Optimistic paid flag after Refresh payment status / confirm. */
  const [localMarkedPaid, setLocalMarkedPaid] = useState(false);
  const [showMarkPaid, setShowMarkPaid] = useState(false);
  const [markingPaidBusy, setMarkingPaidBusy] = useState(false);
  /** When opened without existingDocument (e.g. from trucks), load saved invoice for payment status. */
  const [fetchedDocument, setFetchedDocument] = useState<CustomerDocument | null>(null);
  /** Live Firestore copy — updates Paid status without manual refresh. */
  const [liveDocument, setLiveDocument] = useState<CustomerDocument | null>(null);
  const [pdfSheet, setPdfSheet] = useState<{
    url: string;
    fileName: string;
    blob: Blob;
  } | null>(null);

  // Email state variables
  const [customerEmail, setCustomerEmail] = useState(order.customerEmail || '');
  const [ccEmails, setCcEmails] = useState(
    existingDocument?.customerEmailCc || order.customerEmailCc || customer?.contactEmailCc || ''
  );
  const [emailSubject, setEmailSubject] = useState(
    `${
      initialDocumentType === 'estimate'
        ? 'Estimate'
        : initialDocumentType === 'credit_memo'
          ? 'Credit Memo'
          : 'Invoice'
    } ${existingDocument?.documentNumber || defaultDocumentNumber(initialDocumentType)}`
  );
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailSentStatus, setEmailSentStatus] = useState<'idle' | 'success' | 'error_smtp' | 'error_general'>('idle');
  const [emailErrorMessage, setEmailErrorMessage] = useState('');
  const [emailQbNote, setEmailQbNote] = useState<string | null>(null);
  const [showEmailPanel, setShowEmailPanel] = useState(false);
  const [selectedReplyTo, setSelectedReplyTo] = useState('');
  /** Only include a Stripe pay button when Stripe is actually connected. */
  const [includePayLinkInEmail, setIncludePayLinkInEmail] = useState(true);
  const [stripePaymentsReady, setStripePaymentsReady] = useState(false);
  const [vendorSuggestions, setVendorSuggestions] = useState<string[]>(DEFAULT_VENDORS);

  // Initialize or reload states when order / document type changes
  useEffect(() => {
    if (!order || !isOpen) return;

    const doc = existingDocument || fetchedDocument;
    const type = doc?.type || initialDocumentType;
    setDocumentType(type);
    const documentContext = `${order.id}:${type}:${doc?.id || 'new'}`;
    if (documentContextRef.current !== documentContext) {
      documentContextRef.current = documentContext;
      setSavedDocumentId(doc?.id || null);
    } else if (doc?.id) {
      setSavedDocumentId(doc.id);
    }

    setBillToName(
      doc?.billToName ||
        customer?.billingName ||
        customer?.name ||
        order.customerName
    );
    setBillToAddress(
      doc?.billToAddress ||
        customer?.billingAddress ||
        customer?.shippingAddress ||
        ''
    );

    const details = order.invoiceDetails;
    const existingNumber =
      doc?.documentNumber || details?.invoiceNumber || null;
    let cancelled = false;
    if (existingNumber) {
      setInvoiceNumber(existingNumber);
    } else {
      setInvoiceNumber(defaultDocumentNumber(type));
      void nextDocumentNumber(type, {
        considerQuickbooks: canUseQuickbooks,
        tenantId
      }).then((num) => {
        if (!cancelled) setInvoiceNumber(num);
      });
    }
    setInvoiceDate(
      doc?.documentDate ||
        details?.invoiceDate ||
        new Date().toISOString().split('T')[0]
    );
    setPaymentTerms(
      doc?.paymentTerms ||
        details?.paymentTerms ||
        customer?.paymentTerms ||
        'Net 30'
    );
    setDueDate(doc?.dueDate || details?.dueDate || '');
    setPoNumber(doc?.poNumber || details?.poNumber || '');
    setReferencedInvoiceNumber(doc?.referencedInvoiceNumber || '');
    setSalesRep(doc?.owner || order.owner || '');
    setTaxRate(
      doc?.taxRate !== undefined
        ? doc.taxRate
        : details?.taxRate !== undefined
          ? details.taxRate
          : 0
    );
    setFreightCharge(
      doc?.freightCharge !== undefined
        ? doc.freightCharge
        : details?.freightCharge !== undefined
          ? details.freightCharge
          : 0
    );
    setDiscount(
      doc?.discount !== undefined
        ? doc.discount
        : details?.discount !== undefined
          ? details.discount
          : 0
    );
    setInvoiceNotes(
      doc?.notes ||
        details?.notes ||
        (type === 'estimate'
          ? t('invoice.defaultNotesEstimate')
          : type === 'credit_memo'
            ? t('invoice.defaultNotesCreditMemo')
            : t('invoice.defaultNotesInvoice'))
    );

    const seedDraftLines = (): PlantOrderItem[] => {
      const fromDoc = doc?.items || [];
      if (fromDoc.length > 0) {
        return fromDoc.map((item) => ({
          id: item.id,
          plantName: item.plantName,
          containerSize: item.containerSize,
          quantity: item.quantity,
          loadedQuantity: 0,
          unitPrice: item.unitPrice,
          unitCost: item.unitCost,
          notes: item.notes,
          substitutes: item.substitutes,
          unavailable: item.unavailable,
          includePhotoLink: item.includePhotoLink,
          photoUrl: item.photoUrl,
          vendor: item.vendor
        }));
      }
      if (order.items.length > 0 && !order.id.startsWith('preview-new-')) {
        return order.items.map((item) => ({ ...item }));
      }
      return [
        {
          id: `line-${Date.now()}`,
          plantName: '',
          containerSize: '',
          quantity: 1,
          loadedQuantity: 0,
          unitPrice: 0
        }
      ];
    };
    const hasSavedItems = Boolean(doc?.items?.length);
    const seededDraftLines =
      type === 'credit_memo' || type === 'estimate' || (type === 'invoice' && hasSavedItems)
        ? seedDraftLines()
        : [];

    setCreditLines(seededDraftLines);

    const pricesMap: Record<string, number> = {};
    if (doc?.items?.length) {
      doc.items.forEach((item) => {
        pricesMap[item.id] = item.unitPrice;
      });
      // Also map any order items not in the saved doc
      order.items.forEach((item) => {
        if (pricesMap[item.id] === undefined) {
          pricesMap[item.id] =
            item.unitPrice !== undefined ? item.unitPrice : getDefaultPriceForSize(item.containerSize);
        }
      });
    } else {
      order.items.forEach((item) => {
        pricesMap[item.id] =
          item.unitPrice !== undefined ? item.unitPrice : getDefaultPriceForSize(item.containerSize);
      });
    }
    seededDraftLines.forEach((item) => {
      if (pricesMap[item.id] === undefined) {
        pricesMap[item.id] =
          item.unitPrice !== undefined
            ? item.unitPrice
            : getDefaultPriceForSize(item.containerSize);
      }
    });
    setItemPrices(pricesMap);

    const subsMap: Record<string, string> = {};
    order.items.forEach((item) => {
      if (item.substitutes) subsMap[item.id] = item.substitutes;
    });
    doc?.items?.forEach((item) => {
      if (item.substitutes != null) subsMap[item.id] = item.substitutes;
    });
    setItemSubstitutes(subsMap);

    const costsMap: Record<string, number> = {};
    order.items.forEach((item) => {
      costsMap[item.id] = item.unitCost ?? 0;
    });
    doc?.items?.forEach((item) => {
      if (item.unitCost !== undefined) costsMap[item.id] = item.unitCost;
    });
    seededDraftLines.forEach((item) => {
      if (costsMap[item.id] === undefined) costsMap[item.id] = item.unitCost ?? 0;
    });
    setItemCosts(costsMap);

    setSaveSuccess(false);

    setCustomerEmail(
      doc?.customerEmail || order.customerEmail || customer?.contactEmail || ''
    );
    setCcEmails(
      doc?.customerEmailCc || order.customerEmailCc || customer?.contactEmailCc || ''
    );
    setEmailSubject(
      `${
        type === 'estimate'
          ? t('invoice.estimate')
          : type === 'credit_memo'
            ? t('invoice.creditMemo')
            : t('invoice.invoice')
      } ${existingNumber || defaultDocumentNumber(type)} from ${nurseryName}`
    );
    setEmailSentStatus('idle');
    setEmailErrorMessage('');
    setShowEmailPanel(false);
    // Depend on identity keys only — live order/customer object updates (e.g. after save)
    // must not wipe savedDocumentId or the Stripe/QuickBooks buttons stay disabled.
    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    order?.id,
    order?.orderNumber,
    existingDocument?.id,
    existingDocument?.type,
    fetchedDocument?.id,
    initialDocumentType,
    customer?.id,
    nurseryName,
    canUseQuickbooks,
    tenantId
  ]);

  useEffect(() => {
    if (!isOpen) {
      setFetchedDocument(null);
      setLocalMarkedPaid(false);
      setShowMarkPaid(false);
      return;
    }
    if (existingDocument) {
      setFetchedDocument(null);
      return;
    }
    if (!order?.id || order.id.startsWith('preview-')) return;

    let cancelled = false;
    listAllDocuments()
      .then((docs) => {
        if (cancelled) return;
        const match = docs.find(
          (d) => d.orderId === order.id && d.type === (initialDocumentType || 'invoice')
        );
        if (match) {
          setFetchedDocument(match);
          setSavedDocumentId(match.id);
        }
      })
      .catch(() => {
        /* ignore — payment badge simply won't show until reopen from Customers */
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, existingDocument, order?.id, initialDocumentType]);

  useEffect(() => {
    if (!isOpen) return;
    if (canUseQuickbooks && documentType === 'invoice') {
      setIncludePayLinkInEmail(true);
    }
  }, [isOpen, canUseQuickbooks, documentType]);

  useEffect(() => {
    if (!isOpen || !savedDocumentId) {
      setLiveDocument(null);
      return;
    }
    return subscribeToDocument(savedDocumentId, (doc) => {
      setLiveDocument(doc);
      if (doc?.paymentStatus === 'paid') setLocalMarkedPaid(true);
      if (doc?.qboInvoiceLink) setPayLinkUrl(doc.qboInvoiceLink);
      else if (doc?.stripeCheckoutUrl) setPayLinkUrl(doc.stripeCheckoutUrl);
    });
  }, [isOpen, savedDocumentId]);

  // Handle default due date auto-calculation when date or terms change
  useEffect(() => {
    if (!invoiceDate) return;
    const next = dueDateFromPaymentTerms(invoiceDate, paymentTerms);
    if (next) setDueDate(next);
  }, [invoiceDate, paymentTerms]);

  // Synchronize email subject when document number / type changes
  useEffect(() => {
    setEmailSubject(
      t('invoice.emailSubjectFrom', {
        docLabel:
          documentType === 'estimate'
            ? t('invoice.estimate')
            : documentType === 'credit_memo'
              ? t('invoice.creditMemo')
              : t('invoice.invoice'),
        number: invoiceNumber,
        nurseryName
      })
    );
  }, [invoiceNumber, documentType, nurseryName, t]);

  const isCreditMemo = documentType === 'credit_memo';
  const isEstimate = documentType === 'estimate';
  const activeSavedDoc = existingDocument || fetchedDocument || liveDocument;
  /** Estimates, credit memos, and saved invoices allow add/edit/remove plant lines. */
  const canEditLines =
    isCreditMemo || isEstimate || (documentType === 'invoice' && Boolean(activeSavedDoc?.id));
  const docLabel =
    documentType === 'estimate'
      ? t('invoice.estimate')
      : isCreditMemo
        ? t('invoice.creditMemo')
        : t('invoice.invoice');
  const docLabelUpper = docLabel.toUpperCase();
  const workingItems = canEditLines ? creditLines : order.items;
  const totalLabel =
    documentType === 'estimate'
      ? t('invoice.estimateTotal')
      : isCreditMemo
        ? t('invoice.creditAmount')
        : t('invoice.balanceDue');
  const totalLabelUsd =
    documentType === 'estimate'
      ? t('invoice.estimateTotalUsd')
      : isCreditMemo
        ? t('invoice.creditAmountUsd')
        : t('invoice.balanceDueUsd');

  // Compute Active Item Quantity based on Qty Basis
  const getItemQty = (item: PlantOrderItem): number => {
    if (canEditLines) return Math.max(0, Number(item.quantity) || 0);
    if (qtyBasis === 'pulled') {
      return item.pulledQuantity ?? 0;
    }
    if (qtyBasis === 'loaded') {
      return item.loadedQuantity;
    }
    return item.quantity;
  };

  const updateDraftLine = (id: string, patch: Partial<PlantOrderItem>) => {
    setCreditLines((prev) =>
      prev.map((line) => {
        if (line.id !== id) return line;
        const next = { ...line, ...patch };
        if (patch.includePhotoLink === false) {
          next.photoUrl = null;
        }
        return next;
      })
    );
  };

  /** Explicit photo only — never auto-matched from inventory. */
  const linePhotoUrl = (item: PlantOrderItem): string | null => {
    if (!item.includePhotoLink) return null;
    return isHttpUrl(item.photoUrl) ? item.photoUrl.trim() : null;
  };

  const plantsWithPhotos = inventoryPlants
    .filter((p) => isHttpUrl(p.photoUrl))
    .slice()
    .sort((a, b) => a.plantName.localeCompare(b.plantName));

  async function handleEstimatePhotoUpload(item: PlantOrderItem, file: File) {
    if (!tenantId) {
      setPhotoPickError(t('invoice.photoUploadNeedTenant'));
      return;
    }
    setPhotoPickError(null);
    setPhotoUploadBusyId(item.id);
    try {
      const { photoUrl } = await uploadEstimateLinePhoto({
        tenantId,
        lineId: item.id,
        file
      });
      updateDraftLine(item.id, { includePhotoLink: true, photoUrl });
    } catch (err: any) {
      setPhotoPickError(err?.message || t('invoice.photoUploadFailed'));
    } finally {
      setPhotoUploadBusyId(null);
    }
  }

  const addDraftLine = () => {
    const id = `line-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setCreditLines((prev) => [
      ...prev,
      {
        id,
        plantName: '',
        containerSize: '',
        quantity: 1,
        loadedQuantity: 0,
        unitPrice: 0
      }
    ]);
    setItemPrices((prev) => ({ ...prev, [id]: 0 }));
    setItemCosts((prev) => ({ ...prev, [id]: 0 }));
  };

  const removeDraftLine = (id: string) => {
    setCreditLines((prev) => (prev.length <= 1 ? prev : prev.filter((line) => line.id !== id)));
  };

  // Calculate Order Totals (unavailable estimate lines stay visible but do not count)
  const subtotal = workingItems.reduce((sum, item) => {
    if (item.unavailable) return sum;
    const qty = getItemQty(item);
    const price = itemPrices[item.id] ?? 0;
    return sum + qty * price;
  }, 0);

  const discountAmount = Math.min(subtotal, discount);
  const taxableAmount = Math.max(0, subtotal - discountAmount);
  const salesTax = Number(((taxableAmount * taxRate) / 100).toFixed(2));
  const grandTotal = subtotal - discountAmount + salesTax + freightCharge;
  const paymentDocument = liveDocument || existingDocument || fetchedDocument;
  const paymentStatus = localMarkedPaid ? 'paid' : paymentDocument?.paymentStatus;
  const isPaid = documentType === 'invoice' && paymentStatus === 'paid';
  const amountPaid =
    isPaid
      ? typeof paymentDocument?.stripePaidAmountCents === 'number'
        ? paymentDocument.stripePaidAmountCents / 100
        : grandTotal
      : 0;
  const balanceDue = isPaid ? 0 : grandTotal;
  const activePayLinkUrl =
    !isPaid && documentType === 'invoice'
      ? payLinkUrl ||
        paymentDocument?.qboInvoiceLink ||
        paymentDocument?.stripeCheckoutUrl ||
        null
      : null;
  /** Prefer QuickBooks for customer pay links; Stripe stays available only when QBO is off. */
  const useQboPayLinks = Boolean(canUseQuickbooks);
  const useStripePayLinks = Boolean(canCollectPayments && stripePaymentsReady && !useQboPayLinks);

  // Internal cost/profit (never shown to the customer)
  const totalCost = workingItems.reduce((sum, item) => {
    if (item.unavailable) return sum;
    const qty = getItemQty(item);
    const cost = itemCosts[item.id] ?? 0;
    return sum + qty * cost;
  }, 0);
  const totalProfit = subtotal - totalCost;
  const profitMargin = subtotal > 0 ? (totalProfit / subtotal) * 100 : 0;

  // HTML Email Layout Builder
  const generateEmailHTML = (payUrlOverride?: string | null): string => {
    const payUrl = payUrlOverride === undefined ? activePayLinkUrl : payUrlOverride;
    const itemsRows = workingItems.map((item) => {
      const qty = getItemQty(item);
      const price = itemPrices[item.id] !== undefined ? itemPrices[item.id] : getDefaultPriceForSize(item.containerSize);
      const unavailable = Boolean(item.unavailable);
      const total = unavailable ? 0 : qty * price;
      const muted = unavailable ? '#94a3b8' : undefined;
      const note = String(item.notes || '').trim();
      const noteHtml = note
        ? `<div style="margin-top:4px;font-size:11px;color:#64748b;font-weight:normal;font-style:italic;">${t('invoice.notePrefix')} ${note}</div>`
        : '';
      const subs = (itemSubstitutes[item.id] ?? item.substitutes ?? '').trim();
      const subsHtml = subs
        ? `<div style="margin-top:4px;font-size:11px;color:#64748b;font-weight:normal;font-style:italic;">Possible subs: ${subs}</div>`
        : '';
      const unavailableHtml = unavailable
        ? `<div style="margin-top:4px;font-size:11px;color:#b91c1c;font-weight:bold;">${t('invoice.notAvailable')}</div>`
        : '';
      const photo = linePhotoUrl(item);
      const photoHtml = photo
        ? `<div style="margin-top:4px;font-size:11px;"><a href="${photo}" style="color:#0e7490;font-weight:bold;text-decoration:underline;" target="_blank" rel="noopener noreferrer">${t('invoice.viewPhoto')}</a></div>`
        : '';
      const nameStyle = unavailable
        ? 'padding: 10px 0; font-weight: bold; color: #94a3b8; font-family: sans-serif; text-decoration: line-through;'
        : 'padding: 10px 0; font-weight: bold; color: #0f172a; font-family: sans-serif;';
      return `
        <tr style="border-bottom: 1px solid #e2e8f0;${unavailable ? ' background-color: #f8fafc;' : ''}">
          <td style="${nameStyle}">${item.plantName}${unavailableHtml}${photoHtml}${noteHtml}${subsHtml}</td>
          <td style="padding: 10px 0; text-align: center; color: ${muted || '#64748b'}; font-family: sans-serif;">${item.containerSize}</td>
          <td style="padding: 10px 0; text-align: center; font-weight: bold; color: ${muted || '#0f172a'}; font-family: sans-serif;">${qty}</td>
          <td style="padding: 10px 0; text-align: right; color: ${muted || '#0e7490'}; font-family: sans-serif;">${unavailable ? '—' : `$${price.toFixed(2)}`}</td>
          <td style="padding: 10px 0; text-align: right; font-weight: bold; color: ${muted || '#0f172a'}; font-family: sans-serif;">${unavailable ? '—' : `$${total.toFixed(2)}`}</td>
        </tr>
      `;
    }).join('');

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; color: #1e293b; background-color: #ffffff; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
        ${
          logoSrc && !logoSrc.startsWith('data:')
            ? `<img src="${logoSrc}" alt="${nurseryName} logo" style="height: 56px; width: auto; max-width: 160px; object-fit: contain; margin-bottom: 8px;" />`
            : ''
        }
        <h1 style="color: #0e7490; margin-bottom: 2px; font-size: 24px; font-weight: 800; text-transform: uppercase; font-family: Arial, sans-serif;">${nurseryName}</h1>
        <p style="font-size: 11px; color: #0e7490; font-weight: bold; margin-top: 0; text-transform: uppercase; letter-spacing: 1.5px; font-family: Arial, sans-serif;">${t('invoice.wholesaleNursery')}</p>
        
        <div style="margin: 25px 0; padding: 18px; background-color: #f0fdf4; border-radius: 8px; border: 1px solid #dcfce7; font-family: Arial, sans-serif;">
          <h2 style="font-size: 18px; margin: 0 0 8px 0; color: #14532d; font-weight: 800;">${docLabel} ${invoiceNumber}</h2>
          <table style="width: 100%; font-size: 13px; font-family: Arial, sans-serif;">
            <tr>
              <td style="padding: 2px 0; color: #475569;"><strong>${docLabel} Date:</strong></td>
              <td style="padding: 2px 0; text-align: right; color: #0f172a;">${new Date(invoiceDate).toLocaleDateString(undefined, { dateStyle: 'long' })}</td>
            </tr>
            <tr>
              <td style="padding: 2px 0; color: #475569;"><strong>Terms:</strong></td>
              <td style="padding: 2px 0; text-align: right; color: #0e7490; font-weight: bold;">${paymentTerms}</td>
            </tr>
            <tr>
              <td style="padding: 2px 0; color: #475569;"><strong>Due Date:</strong></td>
              <td style="padding: 2px 0; text-align: right; color: #0f172a; font-weight: bold;">${dueDate ? new Date(dueDate).toLocaleDateString(undefined, { dateStyle: 'long' }) : t('invoice.uponReceipt')}</td>
            </tr>
          </table>
        </div>

        <div style="margin-bottom: 25px; font-size: 13px; font-family: Arial, sans-serif;">
          <h3 style="color: #0e7490; border-bottom: 2px solid #e2e8f0; padding-bottom: 5px; margin-bottom: 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">${t('invoice.billToCustomer')}</h3>
          <p style="margin: 0; font-weight: bold; font-size: 14px; color: #0f172a;">${billToName}</p>
          <p style="margin: 5px 0 0 0; color: #475569; white-space: pre-wrap; line-height: 1.4;">${billToAddress}</p>
        </div>

        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 25px; font-family: Arial, sans-serif;">
          <thead>
            <tr style="border-bottom: 2px solid #cbd5e1; color: #475569; text-align: left; font-size: 11px; text-transform: uppercase;">
              <th style="padding-bottom: 8px;">Plant Name</th>
              <th style="padding-bottom: 8px; text-align: center; width: 80px;">Size</th>
              <th style="padding-bottom: 8px; text-align: center; width: 60px;">Qty</th>
              <th style="padding-bottom: 8px; text-align: right; width: 90px;">Price</th>
              <th style="padding-bottom: 8px; text-align: right; width: 90px;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsRows}
          </tbody>
        </table>

        <div style="width: 280px; margin-left: auto; font-size: 13px; border-top: 2px solid #e2e8f0; padding-top: 10px; font-family: Arial, sans-serif;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 4px 0; color: #475569;">Subtotal:</td>
              <td style="padding: 4px 0; text-align: right; font-weight: bold; color: #0f172a;">$${subtotal.toFixed(2)}</td>
            </tr>
            ${freightCharge > 0 ? `
            <tr>
              <td style="padding: 4px 0; color: #475569;">Freight / Shipping:</td>
              <td style="padding: 4px 0; text-align: right; font-weight: bold; color: #0f172a;">$${freightCharge.toFixed(2)}</td>
            </tr>` : ''}
            ${discount > 0 ? `
            <tr>
              <td style="padding: 4px 0; color: #b91c1c;">Discount:</td>
              <td style="padding: 4px 0; text-align: right; font-weight: bold; color: #b91c1c;">-$${discountAmount.toFixed(2)}</td>
            </tr>` : ''}
            ${taxRate > 0 ? `
            <tr>
              <td style="padding: 4px 0; color: #475569;">Sales Tax (${taxRate}%):</td>
              <td style="padding: 4px 0; text-align: right; font-weight: bold; color: #0f172a;">$${salesTax.toFixed(2)}</td>
            </tr>` : ''}
            ${documentType === 'invoice' && isPaid ? `
            <tr>
              <td style="padding: 4px 0; color: #475569;">Invoice Total:</td>
              <td style="padding: 4px 0; text-align: right; font-weight: bold; color: #0f172a;">$${grandTotal.toFixed(2)}</td>
            </tr>
            <tr>
              <td style="padding: 4px 0; color: #047857;">Amount Paid:</td>
              <td style="padding: 4px 0; text-align: right; font-weight: bold; color: #047857;">$${amountPaid.toFixed(2)}</td>
            </tr>` : ''}
            <tr style="border-top: 1px solid #cbd5e1;">
              <td style="padding: 10px 0 0 0; font-size: 15px; font-weight: bold; color: #0e7490; text-transform: uppercase;">${
                documentType === 'estimate'
                  ? 'Estimate Total'
                  : isCreditMemo
                    ? 'Credit Amount'
                    : 'Balance Due'
              }:</td>
              <td style="padding: 10px 0 0 0; text-align: right; font-size: 16px; font-weight: 800; color: #0e7490;">$${balanceDue.toFixed(2)}</td>
            </tr>
          </table>
        </div>

        ${invoiceNotes ? `
        <div style="margin-top: 30px; padding: 15px; background-color: #f8fafc; border-radius: 8px; font-size: 12px; color: #475569; border: 1px solid #e2e8f0; font-family: Arial, sans-serif;">
          <strong style="display: block; margin-bottom: 5px; color: #0f172a; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px;">Notes & Delivery Instructions:</strong>
          <p style="margin: 0; line-height: 1.5; white-space: pre-wrap;">${invoiceNotes}</p>
        </div>` : ''}

        ${
          payUrl
            ? `
        <div style="margin-top: 28px; text-align: center; font-family: Arial, sans-serif;">
          <a href="${payUrl}" style="display: inline-block; background-color: #5b21b6; color: #ffffff; text-decoration: none; font-weight: 800; font-size: 14px; padding: 14px 28px; border-radius: 10px;">
            ${t('invoice.payOnlineButton', { amount: balanceDue.toFixed(2) })}
          </a>
          <p style="margin: 12px 0 0 0; font-size: 11px; color: #64748b; line-height: 1.4;">
            ${t('invoice.payOnlineLinkFallback')}<br/>
            <a href="${payUrl}" style="color: #5b21b6; word-break: break-all;">${payUrl}</a>
          </p>
        </div>`
            : ''
        }

        <div style="margin-top: 30px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 15px; font-family: Arial, sans-serif;">
          <p style="margin: 0 0 8px 0; color: #475569;">${t('invoice.emailPdfAttached', { docLabel: docLabel.toLowerCase() })}</p>
          <p style="margin: 0;">${nurseryName}</p>
          <p style="margin: 5px 0 0 0; font-weight: bold; color: #0e7490;">Thank you for your business!</p>
        </div>
      </div>
    `;
  };

  // Plain Text Email Builder
  const generateEmailText = (payUrlOverride?: string | null): string => {
    const payUrl = payUrlOverride === undefined ? activePayLinkUrl : payUrlOverride;
    const itemsText = workingItems.map((item) => {
      const qty = getItemQty(item);
      const price = itemPrices[item.id] !== undefined ? itemPrices[item.id] : getDefaultPriceForSize(item.containerSize);
      const unavailable = Boolean(item.unavailable);
      const total = unavailable ? 0 : qty * price;
      const note = String(item.notes || '').trim();
      const subs = (itemSubstitutes[item.id] ?? item.substitutes ?? '').trim();
      const priceLabel = unavailable ? '—' : `$${price.toFixed(2).padEnd(6)}`;
      const totalLabel = unavailable ? '—' : `$${total.toFixed(2)}`;
      const line = `${item.plantName.padEnd(30)} | ${item.containerSize.padEnd(8)} | Qty: ${String(qty).padEnd(4)} | Price: ${priceLabel} | Total: ${totalLabel}`;
      const extras = [
        unavailable ? `  ${t('invoice.notAvailable')}` : '',
        (() => {
          const photo = linePhotoUrl(item);
          return photo ? `  ${t('invoice.viewPhoto')}: ${photo}` : '';
        })(),
        note ? `  Note: ${note}` : '',
        subs ? `  Possible subs: ${subs}` : ''
      ]
        .filter(Boolean)
        .join('\n');
      return extras ? `${line}\n${extras}` : line;
    }).join('\n');

    return `
${nurseryName.toUpperCase()}
Wholesale Nursery

${docLabelUpper}: ${invoiceNumber}
Date: ${new Date(invoiceDate).toLocaleDateString(undefined, { dateStyle: 'long' })}
${poNumber.trim() ? `P.O. #: ${poNumber.trim()}\n` : ''}${
      referencedInvoiceNumber.trim()
        ? `Ref Invoice #: ${referencedInvoiceNumber.trim()}\n`
        : ''
    }${
      isCreditMemo
        ? ''
        : `Terms: ${paymentTerms}\nDue Date: ${dueDate ? new Date(dueDate).toLocaleDateString(undefined, { dateStyle: 'long' }) : t('invoice.uponReceipt')}\n`
    }
BILL TO:
${billToName}
${billToAddress}

--------------------------------------------------------------------------------
PLANT ITEMS:
--------------------------------------------------------------------------------
${itemsText}
--------------------------------------------------------------------------------

Subtotal: $${subtotal.toFixed(2)}
${freightCharge > 0 ? `Freight / Shipping: $${freightCharge.toFixed(2)}\n` : ''}${discount > 0 ? `Discount: -$${discountAmount.toFixed(2)}\n` : ''}${taxRate > 0 ? `Sales Tax (${taxRate}%): $${salesTax.toFixed(2)}\n` : ''}${
      documentType === 'estimate'
        ? `ESTIMATE TOTAL (USD): $${grandTotal.toFixed(2)}`
        : isCreditMemo
          ? `CREDIT AMOUNT (USD): $${grandTotal.toFixed(2)}`
          : isPaid
            ? `INVOICE TOTAL (USD): $${grandTotal.toFixed(2)}\nAmount Paid: $${amountPaid.toFixed(2)}\nBALANCE DUE (USD): $0.00`
            : `BALANCE DUE (USD): $${balanceDue.toFixed(2)}`
    }

${invoiceNotes ? `NOTES:\n${invoiceNotes}\n` : ''}${
      payUrl
        ? `\nPAY ONLINE:\n${payUrl}\n`
        : ''
    }
Thank you for choosing ${nurseryName}!
A PDF copy of this ${docLabel.toLowerCase()} is attached.
`;
  };

  // Direct Server Email Dispatch
  const handleSendEmailServer = async () => {
    if (!tenantId) {
      setEmailSentStatus('error_general');
      setEmailErrorMessage(t('invoice.nurseryContextMissing'));
      return;
    }
    if (!looksLikeEmail(customerEmail)) {
      setEmailSentStatus('error_general');
      setEmailErrorMessage(t('invoice.validEmailRequired'));
      return;
    }
    const { cc, invalid } = parseCcEmails(ccEmails, customerEmail);
    if (invalid.length) {
      setEmailSentStatus('error_general');
      setEmailErrorMessage(t('invoice.ccInvalid', { emails: invalid.join(', ') }));
      return;
    }
    if (cc.length > MAX_CC_RECIPIENTS) {
      setEmailSentStatus('error_general');
      setEmailErrorMessage(t('invoice.ccTooMany', { n: MAX_CC_RECIPIENTS }));
      return;
    }

    setIsSendingEmail(true);
    setEmailSentStatus('idle');
    setEmailErrorMessage('');
    setEmailQbNote(null);

    try {
      const qbSync = await syncToQuickbooksOnEmail();
      if (qbSync.note) setEmailQbNote(qbSync.note);

      // Pay links are optional — never block sending. Use the URL returned here
      // (not React state) so a just-synced QuickBooks invoiceLink makes it into HTML.
      let emailPayUrl: string | null = qbSync.qboInvoiceLink || activePayLinkUrl;
      const wantPayLink =
        includePayLinkInEmail &&
        documentType === 'invoice' &&
        !isPaid &&
        Boolean(useQboPayLinks || useStripePayLinks);
      if (wantPayLink) {
        try {
          emailPayUrl = await ensurePayLink();
        } catch (payErr) {
          console.warn('Invoice email continuing without pay link:', payErr);
        }
      } else {
        emailPayUrl = null;
      }
      const emailHtml = generateEmailHTML(emailPayUrl);
      const emailText = generateEmailText(emailPayUrl);
      const pdfDoc = await buildDocumentPdf();
      const pdfAttachment = {
        filename: pdfDoc.fileName,
        content: await blobToBase64(pdfDoc.blob)
      };

      const result = await sendInvoiceEmail({
        tenantId,
        to: customerEmail,
        cc,
        subject: emailSubject,
        text: emailText,
        html: emailHtml,
        fromName: nurseryName,
        fromEmail: selectedReplyTo || undefined,
        pdfAttachment
      });

      if (result.success) {
        const ccJoined = cc.join(', ') || undefined;
        if (!order.id.startsWith('preview-')) {
          const updatedOrder: CustomerOrder = {
            ...order,
            customerEmail,
            customerEmailCc: ccJoined,
            emailSentAt: new Date().toISOString()
          };
          await updateCustomerOrder(updatedOrder);
        }
        const savedDoc = liveDocument || existingDocument || fetchedDocument;
        if (savedDocumentId && savedDoc) {
          await updateCustomerDocument({
            ...savedDoc,
            id: savedDocumentId,
            customerEmail,
            customerEmailCc: ccJoined,
            emailSentAt: new Date().toISOString()
          });
        }
        setEmailSentStatus('success');
      } else if (
        result.code === 'TENANT_SMTP_NOT_CONFIGURED' ||
        result.code === 'SMTP_NOT_CONFIGURED' ||
        result.code === 'RESEND_NOT_CONFIGURED'
      ) {
        setEmailSentStatus('error_smtp');
        setEmailErrorMessage(
          result.message ||
            t('invoice.emailNotConfiguredResend')
        );
      } else {
        setEmailSentStatus('error_general');
        setEmailErrorMessage(result.error || t('invoice.dispatchEmailFailed'));
      }
    } catch (err: any) {
      console.error('Email sending error:', err);
      setEmailSentStatus('error_general');
      const raw = err?.message || t('invoice.unexpectedEmailError');
      setEmailErrorMessage(
        /firebase admin is not configured/i.test(String(raw))
          ? t('invoice.firebaseAdminMissing')
          : raw
      );
    } finally {
      setIsSendingEmail(false);
    }
  };

  // Fallback: Open Default Mail Client
  const handleOpenMailClient = () => {
    if (!looksLikeEmail(customerEmail)) {
      setEmailSentStatus('error_general');
      setEmailErrorMessage(t('invoice.emailFirstRequired'));
      return;
    }
    const { cc, invalid } = parseCcEmails(ccEmails, customerEmail);
    if (invalid.length) {
      setEmailSentStatus('error_general');
      setEmailErrorMessage(t('invoice.ccInvalid', { emails: invalid.join(', ') }));
      return;
    }
    if (cc.length > MAX_CC_RECIPIENTS) {
      setEmailSentStatus('error_general');
      setEmailErrorMessage(t('invoice.ccTooMany', { n: MAX_CC_RECIPIENTS }));
      return;
    }
    void syncToQuickbooksOnEmail().then((qbSync) => {
      if (qbSync.note) setEmailQbNote(qbSync.note);
    });
    const textBody = generateEmailText();
    window.open(
      mailtoUrl({
        to: customerEmail,
        cc,
        subject: emailSubject,
        body: textBody
      }),
      '_blank'
    );
    
    // Save email only tracking
    const saveEmailTracking = async () => {
      try {
        const updatedOrder: CustomerOrder = {
          ...order,
          customerEmail,
          customerEmailCc: cc.join(', ') || undefined,
          emailSentAt: new Date().toISOString() + ' (opened in mail client)',
        };
        await updateCustomerOrder(updatedOrder);
      } catch (e) {
        console.error('Error tracking email event:', e);
      }
    };
    saveEmailTracking();
  };

  // Must stay above the !isOpen early return — hooks cannot run conditionally.
  useEffect(() => {
    if (!isOpen || !tenantId) {
      setVendorSuggestions(DEFAULT_VENDORS);
      return;
    }
    return subscribeToVendors((vendors) => {
      const names = vendors.map((v) => v.name.trim()).filter(Boolean);
      const merged = Array.from(new Set([...names, ...DEFAULT_VENDORS])).sort((a, b) =>
        a.localeCompare(b)
      );
      setVendorSuggestions(merged);
    });
  }, [isOpen, tenantId]);

  useEffect(() => {
    if (!isOpen || !tenantId) {
      setInventoryPlants([]);
      return;
    }
    return subscribeToInventory(setInventoryPlants);
  }, [isOpen, tenantId]);

  useEffect(() => {
    if (!isOpen || !tenantId || !canCollectPayments) {
      setStripePaymentsReady(false);
      return;
    }
    let cancelled = false;
    void fetchStripeStatus(tenantId)
      .then((status) => {
        if (cancelled) return;
        const ready = Boolean(status.connected && status.chargesEnabled);
        setStripePaymentsReady(ready);
        setIncludePayLinkInEmail(ready);
      })
      .catch(() => {
        if (cancelled) return;
        setStripePaymentsReady(false);
        setIncludePayLinkInEmail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, tenantId, canCollectPayments]);

  useEffect(() => {
    if (!isOpen || !tenantId || !savedDocumentId || !canCollectPayments) return;
    if (documentType !== 'invoice' || localMarkedPaid) return;
    const status = existingDocument?.paymentStatus || fetchedDocument?.paymentStatus;
    if (status !== 'pending') return;

    let cancelled = false;
    void (async () => {
      try {
        const result = await confirmInvoicePayment({
          tenantId,
          documentId: savedDocumentId,
          sessionId: (existingDocument || fetchedDocument)?.stripeCheckoutSessionId
        });
        if (!cancelled && result.paid) setLocalMarkedPaid(true);
      } catch {
        // silent — user can still click Refresh payment status
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    tenantId,
    savedDocumentId,
    canCollectPayments,
    documentType,
    existingDocument?.paymentStatus,
    existingDocument?.stripeCheckoutSessionId,
    fetchedDocument?.paymentStatus,
    fetchedDocument?.stripeCheckoutSessionId,
    localMarkedPaid
  ]);

  if (!isOpen) return null;

  // Pricing edit change handler
  const handlePriceChange = (itemId: string, newPrice: number) => {
    setItemPrices((prev) => ({
      ...prev,
      [itemId]: Math.max(0, newPrice),
    }));
    setSaveSuccess(false);
  };

  // Cost edit change handler (internal profit tracking)
  const handleCostChange = (itemId: string, newCost: number) => {
    setItemCosts((prev) => ({
      ...prev,
      [itemId]: Math.max(0, newCost)
    }));
    setSaveSuccess(false);
  };

  // Restore Default Wholesale Prices
  const handleResetPrices = () => {
    const defaultPrices: Record<string, number> = {};
    workingItems.forEach((item) => {
      defaultPrices[item.id] = getDefaultPriceForSize(item.containerSize);
    });
    setItemPrices(defaultPrices);
    setSaveSuccess(false);
  };

  const uniqueTruckOrders = truckOrders.filter(
    (candidate, index, all) =>
      candidate.id &&
      all.findIndex((other) => other.id === candidate.id) === index
  );
  const canAllocateFreight =
    documentType === 'invoice' &&
    freightCharge > 0 &&
    !!order.truckId &&
    uniqueTruckOrders.length > 1 &&
    !order.invoiceDetails?.freightAllocation &&
    !existingDocument?.freightAllocation;

  const handleSaveInvoice = () => {
    if (canAllocateFreight) {
      setShowFreightAllocation(true);
      return;
    }
    void saveInvoice();
  };

  const handleDeleteDocument = async () => {
    if (!savedDocumentId) return;
    const doc = paymentDocument;
    const label = invoiceNumber || doc?.documentNumber || docLabel;
    const confirmMsg =
      doc?.type === 'invoice' && doc.paymentStatus === 'paid'
        ? t('invoice.deletePaidConfirm', { doc: label })
        : t('customers.deleteDocConfirm', { doc: label });
    if (!window.confirm(confirmMsg)) return;

    setIsSaving(true);
    try {
      await deleteCustomerDocument(savedDocumentId);
      void logAuditEvent({
        action: `${documentType}.deleted`,
        summary: `Deleted ${documentType} ${label}`,
        metadata: { documentId: savedDocumentId, documentNumber: label }
      });
      onClose();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : t('customers.deleteDocFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleFreightChoice = (method: FreightAllocationMethod | 'keep') => {
    setShowFreightAllocation(false);
    if (method === 'keep') {
      void saveInvoice();
      return;
    }
    const shares = allocateFreight(freightCharge, uniqueTruckOrders, method);
    void saveInvoice(shares, method, freightCharge);
  };

  // Persist prices to order + save estimate/invoice under the customer
  const saveInvoice = async (
    freightShares?: FreightShare[],
    freightMethod?: FreightAllocationMethod,
    totalFreight?: number
  ) => {
    setIsSaving(true);
    setSaveSuccess(false);

    try {
      const currentFreight =
        freightShares?.find((share) => share.orderId === order.id)?.amount ?? freightCharge;
      const freightAllocation: FreightAllocation | undefined =
        freightShares && freightMethod && order.truckId && totalFreight !== undefined
          ? {
              truckId: order.truckId,
              totalFreight,
              method: freightMethod,
              allocatedAt: new Date().toISOString()
            }
          : order.invoiceDetails?.freightAllocation || existingDocument?.freightAllocation;
      const savedGrandTotal = subtotal - discountAmount + salesTax + currentFreight;

      const updatedItems = workingItems.map((item) => ({
        ...item,
        unitPrice:
          itemPrices[item.id] !== undefined
            ? itemPrices[item.id]
            : getDefaultPriceForSize(item.containerSize),
        unitCost: itemCosts[item.id] !== undefined ? itemCosts[item.id] : item.unitCost,
        substitutes: (itemSubstitutes[item.id] ?? item.substitutes ?? '').trim() || undefined,
        unavailable: isEstimate ? Boolean(item.unavailable) : undefined,
        includePhotoLink: isEstimate ? Boolean(item.includePhotoLink) || undefined : undefined,
        photoUrl:
          isEstimate && item.includePhotoLink
            ? isHttpUrl(item.photoUrl)
              ? item.photoUrl.trim()
              : null
            : undefined,
        vendor:
          isEstimate
            ? String(item.vendor || '').trim() || undefined
            : isCreditMemo
              ? undefined
              : item.vendor
      }));

      if (canEditLines) {
        const blank = updatedItems.some((item) => !String(item.plantName || '').trim());
        if (blank || updatedItems.length === 0) {
          throw new Error(
            isCreditMemo
              ? t('invoice.creditMemoLinesRequired')
              : isEstimate
                ? t('invoice.estimateLinesRequired')
                : t('invoice.invoiceLinesRequired')
          );
        }
      }

      const invoiceDetailsPayload: InvoiceDetails = {
        invoiceNumber,
        invoiceDate,
        dueDate,
        poNumber: poNumber.trim() || undefined,
        paymentTerms,
        taxRate,
        freightCharge: currentFreight,
        freightAllocation,
        discount,
        notes: invoiceNotes
      };

      const updatedOrder: CustomerOrder = {
        ...order,
        items: updatedItems,
        invoiceDetails: invoiceDetailsPayload,
        customerEmail: customerEmail || order.customerEmail,
        customerEmailCc: parseCcEmails(ccEmails, customerEmail).cc.join(', ') || undefined,
        owner: salesRep.trim() || order.owner || undefined
      };

      const isDocumentOnlyOrder =
        order.id.startsWith('preview-') || isCreditMemo;
      if (!isDocumentOnlyOrder) {
        await updateCustomerOrder(updatedOrder);
      }

      const lineItems = updatedItems.map((item) => ({
        id: item.id,
        plantName: String(item.plantName || '').trim(),
        containerSize: String(item.containerSize || '').trim(),
        quantity: getItemQty(item),
        unitPrice: item.unitPrice ?? 0,
        unitCost: item.unitCost,
        notes: item.notes,
        substitutes: item.substitutes,
        unavailable: isEstimate ? Boolean(item.unavailable) || undefined : undefined,
        includePhotoLink: isEstimate ? Boolean(item.includePhotoLink) || undefined : undefined,
        photoUrl:
          isEstimate && item.includePhotoLink
            ? item.photoUrl || null
            : undefined,
        vendor: isEstimate ? item.vendor : undefined
      }));

      const customerId = customer?.id || order.customerId;
      if (!customerId) {
        throw new Error(t('invoice.noCustomerLinked'));
      }

      const docPayload = {
          customerId,
          customerName: billToName || customer?.name || order.customerName,
          orderId: isDocumentOnlyOrder ? undefined : order.id,
          orderNumber: isDocumentOnlyOrder ? undefined : order.orderNumber,
          type: documentType,
          documentNumber: invoiceNumber,
          documentDate: invoiceDate,
          dueDate: dueDate || undefined,
          poNumber: poNumber.trim() || undefined,
          referencedInvoiceNumber: isCreditMemo
            ? referencedInvoiceNumber.trim() || undefined
            : undefined,
          paymentTerms: isCreditMemo ? undefined : paymentTerms,
          taxRate,
          freightCharge: isCreditMemo ? 0 : currentFreight,
          freightAllocation: isCreditMemo ? undefined : freightAllocation,
          discount: isCreditMemo ? 0 : discount,
          notes: invoiceNotes,
          billToName,
          billToAddress: billToAddress || undefined,
          customerEmail: customerEmail || undefined,
          customerEmailCc: parseCcEmails(ccEmails, customerEmail).cc.join(', ') || undefined,
          owner: salesRep.trim() || undefined,
          items: lineItems,
          subtotal,
          salesTax,
          grandTotal: savedGrandTotal
        };

      const alreadyInQbo = Boolean(
        liveDocument?.qboInvoiceId ||
          existingDocument?.qboInvoiceId ||
          fetchedDocument?.qboInvoiceId
      );
      let persistedId = savedDocumentId;
      if (persistedId) {
          await updateCustomerDocument({
            id: persistedId,
            ...docPayload,
            createdAt:
              existingDocument?.createdAt ||
              fetchedDocument?.createdAt ||
              new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        } else {
          persistedId = await addCustomerDocument(docPayload);
          setSavedDocumentId(persistedId);
        }

        if (freightShares && freightAllocation) {
          const allDocuments = await listAllDocuments();
          const siblingOrders = uniqueTruckOrders.filter((truckOrder) => truckOrder.id !== order.id);

          for (const sibling of siblingOrders) {
            const share = freightShares.find((item) => item.orderId === sibling.id);
            if (!share) continue;

            await updateCustomerOrder({
              ...sibling,
              invoiceDetails: {
                ...sibling.invoiceDetails,
                freightCharge: share.amount,
                freightAllocation
              }
            });

            const siblingInvoice = allDocuments.find(
              (document) => document.type === 'invoice' && document.orderId === sibling.id
            );
            if (siblingInvoice) {
              await updateCustomerDocument({
                ...siblingInvoice,
                freightCharge: share.amount,
                freightAllocation,
                grandTotal:
                  siblingInvoice.subtotal -
                  (siblingInvoice.discount || 0) +
                  siblingInvoice.salesTax +
                  share.amount
              });
              if (canUseQuickbooks && tenantId && siblingInvoice.qboInvoiceId) {
                try {
                  await pushDocumentToQuickbooks({
                    tenantId,
                    documentId: siblingInvoice.id
                  });
                } catch (err: any) {
                  console.warn('[invoice] QBO sibling freight update', err?.message || err);
                }
              }
            }
          }
          setFreightCharge(currentFreight);
        }

      // Keep order linked to the same customer used for the saved document
      if (!isDocumentOnlyOrder && (!order.customerId || order.customerId !== customerId)) {
        await updateCustomerOrder({
          ...updatedOrder,
          customerId,
          customerName: billToName || customer?.name || order.customerName
        });
      }

      await logAuditEvent({
        action: savedDocumentId ? `${documentType}.updated` : `${documentType}.saved`,
        summary: `Saved ${documentType} ${invoiceNumber} for ${billToName || customer?.name || order.customerName}`,
        meta: {
          documentType,
          documentNumber: invoiceNumber,
          customerId,
          orderId: isDocumentOnlyOrder ? null : order.id,
          grandTotal: savedGrandTotal,
          freightAllocationMethod: freightMethod || null,
          totalFreight: totalFreight ?? null
        }
      });

      if (canUseQuickbooks && tenantId && persistedId && alreadyInQbo) {
        try {
          const result = await pushDocumentToQuickbooks({
            tenantId,
            documentId: persistedId
          });
          setLiveDocument((prev) =>
            prev
              ? {
                  ...prev,
                  qboInvoiceId: result.qboInvoiceId,
                  qboInvoiceLink: result.qboInvoiceLink || prev.qboInvoiceLink,
                  qboSyncedAt: new Date().toISOString()
                }
              : prev
          );
          if (result.qboInvoiceLink) setPayLinkUrl(result.qboInvoiceLink);
          setQbPushMessage(
            result.updated ? t('invoice.qbSaveUpdated') : t('invoice.emailAlsoSyncedQb')
          );
        } catch (err: any) {
          console.warn('[invoice] QBO update on save', err?.message || err);
          setQbPushMessage(
            t('invoice.qbSaveSyncFailed', {
              error: err?.message || t('invoice.pushQbFailed')
            })
          );
        }
      }

      setSaveSuccess(true);
    } catch (err: any) {
      console.error('Failed to save document:', err);
      const code = err?.code || '';
      const message = err?.message || String(err);
      if (
        code === 'resource-exhausted' ||
        /RESOURCE_EXHAUSTED|Quota exceeded/i.test(message)
      ) {
        alert(
          t('invoice.quotaExceeded')
        );
      } else if (code === 'permission-denied' || /insufficient permissions/i.test(message)) {
        alert(
          t('invoice.permissionDenied')
        );
      } else if (!customer?.id && !order.customerId) {
        alert(t('invoice.saveLinkCustomer'));
      } else {
        alert(t('invoice.saveFailedGeneric', { message }));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const syncPaymentToQuickbooksIfPossible = async (
    documentId: string,
    opts?: { quiet?: boolean }
  ): Promise<string | null> => {
    if (!tenantId || !canUseQuickbooks || documentType !== 'invoice') return null;
    try {
      const result = await pushPaymentToQuickbooks({ tenantId, documentId });
      if (result.synced && result.qboPaymentId && !result.skipped) {
        setLiveDocument((prev) =>
          prev
            ? {
                ...prev,
                qboPaymentId: result.qboPaymentId || prev.qboPaymentId,
                qboPaymentSyncedAt: new Date().toISOString()
              }
            : prev
        );
        setQbPushMessage(t('invoice.qbPaymentSynced'));
        return t('invoice.qbPaymentSynced');
      }
      if (result.reason === 'invoice_not_pushed') {
        return opts?.quiet ? null : t('invoice.qbPaymentNeedsInvoicePush');
      }
      if (result.reason === 'already_synced' || result.reason === 'already_paid_in_qbo') {
        return t('invoice.qbPaymentAlreadySynced');
      }
      return null;
    } catch (err: any) {
      if (!opts?.quiet) {
        console.warn('[invoice] QBO payment sync', err?.message || err);
      }
      return opts?.quiet ? null : err?.message || t('invoice.qbPaymentSyncFailed');
    }
  };

  const applyQboPushResult = async (result: Awaited<ReturnType<typeof pushDocumentToQuickbooks>>) => {
    await logAuditEvent({
      action: 'quickbooks.document_pushed',
      summary: `Pushed ${documentType} ${invoiceNumber} to QuickBooks (${result.qboInvoiceId})`,
      meta: {
        documentId: savedDocumentId,
        qboInvoiceId: result.qboInvoiceId,
        qboDocType: result.qboDocType,
        qboDocNumber: result.qboDocNumber,
        companyName: result.companyName,
        environment: result.environment
      }
    });
    const where =
      result.environment === 'sandbox'
        ? 'SANDBOX QuickBooks'
        : 'QuickBooks';
    const companyBit = result.companyName ? ` · ${result.companyName}` : '';
    const docBit = result.qboDocNumber
      ? `Doc #${result.qboDocNumber}`
      : `Id ${result.qboInvoiceId}`;
    setLiveDocument((prev) =>
      prev
        ? {
            ...prev,
            qboInvoiceId: result.qboInvoiceId,
            qboInvoiceLink: result.qboInvoiceLink || prev.qboInvoiceLink,
            qboDocNumber: result.qboDocNumber || prev.qboDocNumber,
            documentNumber: result.documentNumber || prev.documentNumber,
            qboSyncedAt: new Date().toISOString()
          }
        : prev
    );
    if (result.documentNumber) {
      const nextNum = String(result.documentNumber).trim();
      if (nextNum && nextNum !== invoiceNumber) {
        setInvoiceNumber(nextNum);
      }
    }
    if (result.qboInvoiceLink) {
      setPayLinkUrl(result.qboInvoiceLink);
      setPayLinkMessage(t('invoice.payLinkReady'));
    }
    setQbPushMessage(`Synced to ${where}${companyBit} · ${docBit}`);
    return { where, companyBit, docBit };
  };

  /** Push invoice/estimate to QBO if QuickBooks is on and the document is saved. Never throws. */
  const syncToQuickbooksOnEmail = async (): Promise<{
    note: string | null;
    qboInvoiceLink: string | null;
  }> => {
    if (!canUseQuickbooks) return { note: null, qboInvoiceLink: null };
    if (documentType !== 'invoice' && documentType !== 'estimate' && documentType !== 'credit_memo') {
      return { note: null, qboInvoiceLink: null };
    }
    if (!tenantId || !savedDocumentId) {
      return { note: t('invoice.emailQbSaveFirst'), qboInvoiceLink: null };
    }
    try {
      const result = await pushDocumentToQuickbooks({
        tenantId,
        documentId: savedDocumentId
      });
      await applyQboPushResult(result);
      if (documentType === 'invoice' && (localMarkedPaid || isPaid)) {
        await syncPaymentToQuickbooksIfPossible(savedDocumentId, { quiet: true });
      }
      return {
        note: result.updated
          ? t('invoice.emailUpdatedInQb')
          : result.reused
            ? t('invoice.emailAlreadyInQb')
            : t('invoice.emailAlsoSyncedQb'),
        qboInvoiceLink: result.qboInvoiceLink || null
      };
    } catch (err: any) {
      console.warn('[invoice] QBO sync on email', err?.message || err);
      return {
        note: t('invoice.emailQbSyncFailed', {
          error: err?.message || t('invoice.pushQbFailed')
        }),
        qboInvoiceLink: null
      };
    }
  };

  const handlePushToQuickbooks = async () => {
    if (!tenantId) {
      alert(t('invoice.nurseryContextMissing'));
      return;
    }
    if (!savedDocumentId) {
      alert(t('invoice.saveDocFirstQb', { docLabel: docLabel.toLowerCase() }));
      return;
    }
    setIsPushingQb(true);
    setQbPushMessage(null);
    try {
      const baseDoc = liveDocument || existingDocument || fetchedDocument;
      if (baseDoc && savedDocumentId) {
        await updateCustomerDocument({
          ...baseDoc,
          id: savedDocumentId,
          freightCharge: isCreditMemo ? 0 : freightCharge,
          taxRate,
          salesTax,
          discount: isCreditMemo ? 0 : discount,
          grandTotal
        });
      }
      const result = await pushDocumentToQuickbooks({
        tenantId,
        documentId: savedDocumentId
      });
      const { where, companyBit, docBit } = await applyQboPushResult(result);
      const customerBit = result.customerName ? ` · customer “${result.customerName}”` : '';
      const totalBit =
        result.totalAmt != null ? ` · $${Number(result.totalAmt).toFixed(2)}` : '';
      const linesBit =
        result.lineCount != null ? ` · ${result.lineCount} plant line(s)` : '';
      const previewBit =
        result.linePreview && result.linePreview.length
          ? `\nPlants: ${result.linePreview.join('; ')}`
          : '';

      let paymentBit = '';
      if (documentType === 'invoice' && (localMarkedPaid || isPaid)) {
        const payMsg = await syncPaymentToQuickbooksIfPossible(savedDocumentId, {
          quiet: true
        });
        if (payMsg) paymentBit = `\n\n${payMsg}`;
      }

      // Stay in NurseryOS — do not auto-open the QuickBooks website.
      alert(
        `${docLabel} ${result.updated ? 'updated in' : 'pushed to'} ${where}${companyBit}.\n\n` +
          `${docBit}${customerBit}${totalBit}${linesBit}${previewBit}${paymentBit}\n\n` +
          (result.qboInvoiceLink
            ? t('invoice.pushQbStayHint')
            : t('invoice.qbLiveHint'))
      );
    } catch (err: any) {
      alert(err?.message || t('invoice.pushQbFailed'));
    } finally {
      setIsPushingQb(false);
    }
  };

  const ensurePayLink = async (): Promise<string> => {
    if (activePayLinkUrl && useQboPayLinks && paymentDocument?.qboInvoiceLink) {
      return activePayLinkUrl;
    }
    if (activePayLinkUrl && useStripePayLinks && paymentDocument?.stripeCheckoutUrl) {
      return activePayLinkUrl;
    }
    if (!tenantId || !savedDocumentId) {
      throw new Error(t('invoice.saveInvoiceFirst'));
    }

    if (useQboPayLinks) {
      const result = await ensureQboPayLink({
        tenantId,
        documentId: savedDocumentId
      });
      setPayLinkUrl(result.url);
      setPayLinkMessage(t('invoice.payLinkReady'));
      setLiveDocument((prev) =>
        prev
          ? {
              ...prev,
              qboInvoiceId: result.qboInvoiceId || prev.qboInvoiceId,
              qboInvoiceLink: result.url
            }
          : prev
      );
      await logAuditEvent({
        action: 'quickbooks.pay_link_created',
        summary: `Created QuickBooks pay link for invoice ${invoiceNumber}`,
        meta: { documentId: savedDocumentId, qboInvoiceId: result.qboInvoiceId }
      });
      return result.url;
    }

    const result = await createInvoiceCheckout({
      tenantId,
      documentId: savedDocumentId
    });
    if (!result.url) {
      throw new Error('Stripe did not return a pay link URL.');
    }
    setPayLinkUrl(result.url);
    setPayLinkMessage(t('invoice.payLinkReady'));
    await logAuditEvent({
      action: 'stripe.checkout_created',
      summary: `Created Stripe pay link for invoice ${invoiceNumber}`,
      meta: { documentId: savedDocumentId, sessionId: result.sessionId }
    });
    return result.url;
  };

  const handleCreatePayLink = async () => {
    if (!tenantId) {
      alert(t('invoice.nurseryContextMissing'));
      return;
    }
    if (!savedDocumentId) {
      alert(t('invoice.saveDocFirstPayLink', { docLabel: docLabel.toLowerCase() }));
      return;
    }
    if (documentType !== 'invoice') {
      alert(t('invoice.stripeInvoiceOnly'));
      return;
    }
    setIsCreatingPayLink(true);
    setPayLinkMessage(null);
    try {
      const url = await ensurePayLink();
      try {
        await navigator.clipboard.writeText(url);
        alert(useQboPayLinks ? t('invoice.qbPayLinkCopied') : t('invoice.payLinkCopied'));
      } catch {
        alert(t('invoice.payLinkReadyAlert', { url }));
      }
    } catch (err: any) {
      alert(err?.message || t('invoice.pushQbFailed'));
    } finally {
      setIsCreatingPayLink(false);
    }
  };

  const handleRefreshPaymentStatus = async (opts?: { silent?: boolean }) => {
    if (!tenantId || !savedDocumentId) {
      if (!opts?.silent) alert(t('invoice.saveInvoiceFirst'));
      return;
    }
    setIsRefreshingPayment(true);
    try {
      if (useQboPayLinks || paymentDocument?.qboInvoiceId) {
        const result = await refreshQboPaymentStatus({
          tenantId,
          documentId: savedDocumentId
        });
        if (result.qboInvoiceLink) setPayLinkUrl(result.qboInvoiceLink);
        if (result.paid) {
          setLocalMarkedPaid(true);
          if (!opts?.silent) alert(t('invoice.paymentConfirmed'));
        } else if (!opts?.silent) {
          const bal =
            result.balance != null && Number.isFinite(result.balance)
              ? result.balance.toFixed(2)
              : '—';
          alert(t('invoice.qbUnpaidBalance', { balance: bal }));
        }
        return;
      }

      const result = await confirmInvoicePayment({
        tenantId,
        documentId: savedDocumentId,
        sessionId: paymentDocument?.stripeCheckoutSessionId
      });
      if (result.paid) {
        setLocalMarkedPaid(true);
        const qbMsg = await syncPaymentToQuickbooksIfPossible(savedDocumentId, {
          quiet: true
        });
        if (!opts?.silent) {
          alert(
            qbMsg
              ? `${t('invoice.paymentConfirmed')}\n\n${qbMsg}`
              : t('invoice.paymentConfirmed')
          );
        }
      } else if (!opts?.silent) {
        alert(
          result.hint ||
            `Stripe still shows this checkout as “${result.paymentStatus || 'unpaid'}”. Create a new pay link, complete payment, then Refresh again.`
        );
      }
    } catch (err: any) {
      if (!opts?.silent) alert(err?.message || t('invoice.refreshPaymentFailed'));
    } finally {
      setIsRefreshingPayment(false);
    }
  };

  const handleExportPdf = async () => {
    try {
      const { blob, fileName } = await buildDocumentPdf();
      const result = await deliverPdfBlob(blob, fileName);
      if (result.method === 'preview') {
        setPdfSheet({
          url: result.url,
          fileName: result.fileName,
          blob: result.blob
        });
      }
    } catch (err) {
      console.error('PDF export failed:', err);
      alert(t('invoice.pdfExportFailed', { message: err instanceof Error ? err.message : t('invoice.unknownError') }));
    }
  };

  const buildDocumentPdf = async (): Promise<{ blob: Blob; fileName: string }> => {
    // Build the PDF programmatically (not a DOM screenshot). html2canvas can't
    // parse Tailwind v4's oklch() colors, which made the old export fail.
    const pdf = new jsPDF('p', 'pt', 'letter');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 40;
      const contentWidth = pageWidth - margin * 2;
      const rightX = pageWidth - margin;
      let y = margin;

      const ensureSpace = (needed = 16): void => {
        if (y + needed > pageHeight - margin) {
          pdf.addPage();
          y = margin;
        }
      };
      const money = (n: number) =>
        `$${(Number.isFinite(n) ? n : 0).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        })}`;

      // Header with nursery logo (when available)
      const headerTop = y;
      let textX = margin;
      if (logoSrc) {
        try {
          const logo = await imageSrcToDataUrl(logoSrc);
          const logoSize = 48;
          pdf.addImage(logo.dataUrl, logo.format, margin, headerTop, logoSize, logoSize);
          textX = margin + logoSize + 12;
        } catch (logoErr) {
          console.warn('Invoice logo could not be embedded in PDF:', logoErr);
        }
      }

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(20);
      pdf.setTextColor(14, 116, 144);
      pdf.text((nurseryName || 'NurseryOS').toUpperCase(), textX, headerTop + 14);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.setTextColor(120, 120, 120);
      pdf.text('WHOLESALE NURSERY', textX, headerTop + 28);

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(14, 116, 144);
      pdf.text(docLabelUpper, rightX, headerTop + 2, { align: 'right' });
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(16);
      pdf.setTextColor(20, 20, 20);
      pdf.text(invoiceNumber || docLabel, rightX, headerTop + 20, { align: 'right' });

      y = headerTop + (logoSrc ? 56 : 40);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(60, 60, 60);
      const metaLines: string[] = [
        `Date: ${invoiceDate ? new Date(invoiceDate).toLocaleDateString() : '—'}`
      ];
      if (poNumber.trim()) metaLines.push(`P.O. #: ${poNumber.trim()}`);
      if (isCreditMemo && referencedInvoiceNumber.trim()) {
        metaLines.push(`Ref Invoice #: ${referencedInvoiceNumber.trim()}`);
      }
      if (!isCreditMemo) {
        metaLines.push(`Terms: ${paymentTerms || '—'}`);
        metaLines.push(
          `Due: ${dueDate ? new Date(dueDate).toLocaleDateString() : t('invoice.uponReceipt')}`
        );
      }
      metaLines.forEach((line) => {
        pdf.text(line, rightX, y, { align: 'right' });
        y += 12;
      });

      // Divider
      y += 2;
      pdf.setDrawColor(200, 200, 200);
      pdf.setLineWidth(1);
      pdf.line(margin, y, rightX, y);
      y += 18;

      // Bill To + Ship origin
      const partiesTop = y;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(14, 116, 144);
      pdf.text(t('invoice.billTo'), margin, partiesTop);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(11);
      pdf.setTextColor(20, 20, 20);
      pdf.text(billToName || order.customerName || '—', margin, partiesTop + 15);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(80, 80, 80);
      let leftY = partiesTop + 28;
      if (billToAddress.trim()) {
        pdf.splitTextToSize(billToAddress.trim(), contentWidth / 2 - 10).forEach((l: string) => {
          pdf.text(l, margin, leftY);
          leftY += 12;
        });
      }

      const originX = margin + contentWidth / 2;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(14, 116, 144);
      pdf.text(t('invoice.shipFrom'), originX, partiesTop);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(80, 80, 80);
      let rightY = partiesTop + 15;
      pdf.text(`Shipper: ${nurseryName}`, originX, rightY);
      rightY += 12;
      const originText = nurseryAddress || t('invoice.defaultOrigin');
      pdf.splitTextToSize(`Origin: ${originText}`, contentWidth / 2 - 10).forEach((l: string) => {
        pdf.text(l, originX, rightY);
        rightY += 12;
      });

      y = Math.max(leftY, rightY) + 10;

      // Items table
      const xPlant = margin;
      const xSize = margin + 250;
      const xQty = margin + 330;
      const xPrice = margin + 420;
      const xTotal = rightX;

      const drawItemsHeader = () => {
        pdf.setDrawColor(180, 180, 180);
        pdf.setLineWidth(1);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(8);
        pdf.setTextColor(110, 110, 110);
        pdf.text(t('invoice.plantVariety'), xPlant, y);
        pdf.text('SIZE', xSize, y);
        pdf.text('QTY', xQty, y, { align: 'right' });
        pdf.text(t('invoice.unitPrice'), xPrice, y, { align: 'right' });
        pdf.text('TOTAL', xTotal, y, { align: 'right' });
        // jsPDF y is text baseline — rule must sit below glyphs, then leave room for next baseline
        y += 4;
        pdf.line(margin, y, rightX, y);
        y += 14;
      };

      ensureSpace(40);
      drawItemsHeader();

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      workingItems.forEach((item) => {
        const qty = getItemQty(item);
        const price =
          itemPrices[item.id] !== undefined
            ? itemPrices[item.id]
            : getDefaultPriceForSize(item.containerSize);
        const unavailable = Boolean(item.unavailable);
        const total = unavailable ? 0 : qty * price;
        const subs = (itemSubstitutes[item.id] ?? item.substitutes ?? '').trim();
        const note = String(item.notes || '').trim();
        const photo = linePhotoUrl(item);

        const nameLines = pdf.splitTextToSize(item.plantName || '—', xSize - xPlant - 10);
        const unavailableLines = unavailable
          ? pdf.splitTextToSize(t('invoice.notAvailable'), xSize - xPlant - 10)
          : [];
        const photoLabel = photo ? t('invoice.viewPhoto') : '';
        const noteLines = note
          ? pdf.splitTextToSize(`${t('invoice.notePrefix')} ${note}`, xSize - xPlant - 10)
          : [];
        const subLines = subs
          ? pdf.splitTextToSize(`${t('invoice.possibleSubs')}: ${subs}`, xSize - xPlant - 10)
          : [];
        const linePitch = 11;
        const textBlockHeight =
          Math.max(9, nameLines.length * linePitch) +
          (unavailableLines.length ? unavailableLines.length * 10 + 2 : 0) +
          (photo ? 12 : 0) +
          (noteLines.length ? noteLines.length * 10 + 2 : 0) +
          (subLines.length ? subLines.length * 10 + 2 : 0);
        // Space for text + padding under glyphs + rule + gap before next baseline
        const rowSpan = textBlockHeight + 16;
        if (y + rowSpan > pageHeight - margin) {
          pdf.addPage();
          y = margin;
          drawItemsHeader();
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(9);
        }

        const baseline = y;
        const ink = unavailable ? [148, 163, 184] as const : [20, 20, 20] as const;
        pdf.setTextColor(ink[0], ink[1], ink[2]);
        nameLines.forEach((l: string, i: number) => {
          pdf.text(l, xPlant, baseline + i * linePitch);
        });
        let belowName = baseline + nameLines.length * linePitch + 1;
        if (unavailableLines.length) {
          pdf.setFontSize(8);
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(185, 28, 28);
          unavailableLines.forEach((l: string, i: number) => {
            pdf.text(l, xPlant, belowName + i * 10);
          });
          belowName += unavailableLines.length * 10 + 2;
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(9);
        }
        if (photo && photoLabel) {
          pdf.setFontSize(8);
          pdf.setFont('helvetica', 'bold');
          pdf.setTextColor(14, 116, 144);
          pdf.textWithLink(photoLabel, xPlant, belowName, { url: photo });
          const linkW = pdf.getTextWidth(photoLabel);
          pdf.link(xPlant, belowName - 7, Math.max(linkW, 28), 10, { url: photo });
          belowName += 12;
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(9);
        }
        if (noteLines.length) {
          pdf.setFontSize(8);
          pdf.setTextColor(100, 100, 100);
          noteLines.forEach((l: string, i: number) => {
            pdf.text(l, xPlant, belowName + i * 10);
          });
          belowName += noteLines.length * 10 + 2;
          pdf.setFontSize(9);
        }
        if (subLines.length) {
          pdf.setFontSize(8);
          pdf.setTextColor(100, 100, 100);
          subLines.forEach((l: string, i: number) => {
            pdf.text(l, xPlant, belowName + i * 10);
          });
          pdf.setFontSize(9);
        }
        pdf.setTextColor(ink[0], ink[1], ink[2]);
        pdf.text(String(item.containerSize || ''), xSize, baseline);
        pdf.text(String(qty), xQty, baseline, { align: 'right' });
        pdf.text(unavailable ? '—' : money(price), xPrice, baseline, { align: 'right' });
        pdf.setFont('helvetica', 'bold');
        pdf.text(unavailable ? '—' : money(total), xTotal, baseline, { align: 'right' });
        pdf.setFont('helvetica', 'normal');

        y = baseline + textBlockHeight + 4;
        pdf.setDrawColor(230, 230, 230);
        pdf.setLineWidth(0.5);
        pdf.line(margin, y, rightX, y);
        y += 12;
      });

      // Totals
      y += 10;
      ensureSpace(90);
      const labelX = margin + contentWidth - 170;
      const writeTotal = (label: string, value: string, bold = false, big = false) => {
        pdf.setFont('helvetica', bold ? 'bold' : 'normal');
        pdf.setFontSize(big ? 12 : 9);
        pdf.setTextColor(bold ? 14 : 90, bold ? 116 : 90, bold ? 144 : 90);
        pdf.text(label, labelX, y);
        pdf.setTextColor(20, 20, 20);
        pdf.text(value, xTotal, y, { align: 'right' });
        y += big ? 20 : 14;
      };

      writeTotal(t('invoice.subtotal'), money(subtotal));
      if (discountAmount > 0) writeTotal(t('invoice.discountLabel'), `-${money(discountAmount)}`);
      if (freightCharge > 0) writeTotal(t('invoice.freightLabel'), money(freightCharge));
      if (salesTax > 0) writeTotal(`Sales Tax (${taxRate}%)`, money(salesTax));
      pdf.setDrawColor(180, 180, 180);
      pdf.setLineWidth(1);
      pdf.line(labelX, y - 4, rightX, y - 4);
      y += 8;
      if (documentType === 'invoice' && isPaid) {
        writeTotal(t('invoice.invoiceTotalLabel'), money(grandTotal), true, false);
        writeTotal(t('invoice.amountPaid'), money(amountPaid), true, false);
        writeTotal(t('invoice.balanceDue'), money(0), true, true);
      } else {
        writeTotal(totalLabel, money(balanceDue), true, true);
      }

      // Notes
      if (invoiceNotes.trim()) {
        y += 10;
        ensureSpace(40);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(8);
        pdf.setTextColor(110, 110, 110);
        pdf.text(t('invoice.notes'), margin, y);
        y += 12;
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
        pdf.setTextColor(70, 70, 70);
        pdf.splitTextToSize(invoiceNotes.trim(), contentWidth).forEach((l: string) => {
          ensureSpace(12);
          pdf.text(l, margin, y);
          y += 12;
        });
      }

      const fileName = `${(invoiceNumber || docLabel).replace(/[^\w.-]+/g, '_')}.pdf`;
      return { blob: pdf.output('blob'), fileName };
  };

  const handleDocumentTypeChange = (type: CustomerDocumentType) => {
    setDocumentType(type);
    setInvoiceNumber(defaultDocumentNumber(type));
    void nextDocumentNumber(type, {
      considerQuickbooks: canUseQuickbooks,
      tenantId
    }).then(setInvoiceNumber);
    setSaveSuccess(false);
    if (type === 'credit_memo' || type === 'estimate') {
      setCreditLines((prev) => {
        if (prev.length > 0) return prev;
        if (order.items.length > 0 && !order.id.startsWith('preview-new-')) {
          const lines = order.items.map((item) => ({ ...item }));
          setItemPrices((prices) => {
            const next = { ...prices };
            lines.forEach((item) => {
              if (next[item.id] === undefined) {
                next[item.id] =
                  item.unitPrice !== undefined
                    ? item.unitPrice
                    : getDefaultPriceForSize(item.containerSize);
              }
            });
            return next;
          });
          return lines;
        }
        const id = `line-${Date.now()}`;
        setItemPrices((prices) => ({ ...prices, [id]: 0 }));
        return [
          {
            id,
            plantName: '',
            containerSize: '',
            quantity: 1,
            loadedQuantity: 0,
            unitPrice: 0
          }
        ];
      });
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-start overflow-y-auto p-4 md:p-8 z-50 print:p-0 print:bg-white print:backdrop-blur-none">
      {pdfSheet && (
        <PdfShareSheet
          url={pdfSheet.url}
          fileName={pdfSheet.fileName}
          blob={pdfSheet.blob}
          title={t('invoice.ready', { docLabel })}
          onClose={() => setPdfSheet(null)}
        />
      )}
      {showMarkPaid && paymentDocument && (
        <MarkPaidModal
          title={t('invoice.markAsPaid')}
          subtitle={`${paymentDocument.documentNumber} · ${paymentDocument.billToName || paymentDocument.customerName}`}
          amountLabel={`$${grandTotal.toFixed(2)}`}
          busy={markingPaidBusy}
          onCancel={() => setShowMarkPaid(false)}
          onConfirm={async (payment) => {
            setMarkingPaidBusy(true);
            try {
              await markCustomerInvoicePaid(paymentDocument, payment);
              setLocalMarkedPaid(true);
              setLiveDocument({
                ...paymentDocument,
                paymentStatus: 'paid',
                paidAt: new Date().toISOString(),
                paymentMethod: payment.method,
                paymentReference: payment.reference,
                stripePaidAmountCents:
                  typeof paymentDocument.stripePaidAmountCents === 'number'
                    ? paymentDocument.stripePaidAmountCents
                    : Math.round(grandTotal * 100)
              });
              setShowMarkPaid(false);
              await logAuditEvent({
                action: 'invoice.marked_paid',
                summary: `Marked ${paymentDocument.documentNumber} paid via ${payment.method}${
                  payment.reference ? ` (${payment.reference})` : ''
                }`,
                meta: {
                  documentId: paymentDocument.id,
                  method: payment.method,
                  reference: payment.reference || null
                }
              });
              const qbMsg = await syncPaymentToQuickbooksIfPossible(paymentDocument.id);
              if (qbMsg) setQbPushMessage(qbMsg);
            } catch (err: any) {
              alert(err?.message || t('invoice.markPaidFailed'));
            } finally {
              setMarkingPaidBusy(false);
            }
          }}
        />
      )}
      {showFreightAllocation && (
        <div className="fixed inset-0 z-[70] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4 print:hidden">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 bg-ink-950 text-white">
              <h3 className="text-base font-black">{t('invoice.distributeFreight')}</h3>
              <p className="text-xs text-ink-200 mt-1">
                This truck has {uniqueTruckOrders.length} orders and ${freightCharge.toFixed(2)} in
                total freight.
              </p>
            </div>
            <div className="p-5 space-y-3">
              <button
                type="button"
                onClick={() => handleFreightChoice('equal')}
                className="w-full text-left rounded-xl border-2 border-slate-200 hover:border-ink-500 hover:bg-ink-50 px-4 py-3 transition-colors"
              >
                <span className="block text-sm font-black text-gray-900">{t('invoice.splitEven')}</span>
                <span className="block text-xs text-slate-500 mt-0.5">
                  Divide the freight equally across all {uniqueTruckOrders.length} invoices.
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleFreightChoice('truckUsage')}
                className="w-full text-left rounded-xl border-2 border-slate-200 hover:border-ink-500 hover:bg-ink-50 px-4 py-3 transition-colors"
              >
                <span className="block text-sm font-black text-gray-900">
                  Split by % of truck used
                </span>
                <span className="block text-xs text-slate-500 mt-0.5">
                  Allocate by each order&apos;s share of the truck&apos;s total plant weight.
                </span>
                <span className="block text-[11px] text-slate-600 mt-2 font-mono">
                  {allocateFreight(freightCharge, uniqueTruckOrders, 'truckUsage')
                    .map((share) => {
                      const shareOrder = uniqueTruckOrders.find(
                        (candidate) => candidate.id === share.orderId
                      );
                      return `${shareOrder?.customerName || 'Order'} ${share.percentage.toFixed(1)}% · $${share.amount.toFixed(2)}`;
                    })
                    .join('  |  ')}
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleFreightChoice('keep')}
                className="w-full text-left rounded-xl border border-slate-200 hover:bg-slate-50 px-4 py-3"
              >
                <span className="block text-sm font-bold text-gray-800">
                  Keep all freight on this invoice
                </span>
              </button>
            </div>
            <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex justify-end">
              <button
                type="button"
                onClick={() => setShowFreightAllocation(false)}
                className="px-3 py-2 text-xs font-bold text-slate-600 hover:text-slate-900"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Modal Container — on mobile stack naturally so the preview isn't flex-collapsed to 0 height */}
      <div className="bg-white w-full max-w-5xl rounded-3xl border border-gray-150 shadow-2xl overflow-visible md:overflow-hidden flex flex-col md:flex-row print:shadow-none print:border-none print:rounded-none">
        
        {/* Left Side: Customize Form (Hidden during print) */}
        <div className="w-full md:w-80 bg-slate-50 border-r border-gray-150 p-4 md:p-6 flex flex-col space-y-4 shrink-0 print:hidden md:overflow-y-auto md:max-h-[85vh] order-2 md:order-1">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-black text-gray-900 font-sans tracking-tight uppercase flex items-center">
              <FileCheck className="h-4 w-4 mr-2 text-ink-800" />
              {docLabel} Settings
            </h3>
            <button
              onClick={onClose}
              className="md:hidden p-1.5 rounded-lg hover:bg-gray-200 text-gray-400 hover:text-gray-900 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {documentType === 'invoice' && (isPaid || paymentStatus === 'pending') && (
            <div
              className={`rounded-xl border px-3 py-2 text-[11px] font-bold ${
                isPaid
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
              }`}
            >
              {isPaid ? (
                <>
                  {t('invoice.paidBadge')}
                  {paymentDocument?.paidAt
                    ? ` · ${new Date(paymentDocument.paidAt).toLocaleDateString()}`
                    : ''}
                  {(paymentDocument?.paymentMethod || paymentDocument?.paymentReference) && (
                    <span className="block font-semibold mt-0.5">
                      {formatPaymentRecord(
                        t,
                        paymentDocument.paymentMethod,
                        paymentDocument.paymentReference
                      )}
                    </span>
                  )}
                </>
              ) : (
                t('invoice.paymentPending')
              )}
            </div>
          )}

          <div className="space-y-3.5 text-xs">
            {/* Estimate / Invoice / Credit memo */}
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1.5 uppercase tracking-wider text-[10px]">
                Document Type
              </label>
              <div className="grid grid-cols-3 gap-1 bg-gray-200/60 p-1 rounded-lg">
                {(['estimate', 'invoice', 'credit_memo'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => handleDocumentTypeChange(type)}
                    className={`py-1.5 text-[10px] font-bold rounded-md capitalize transition-all ${
                      documentType === type
                        ? 'bg-ink-700 text-white shadow-sm'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-300/40'
                    }`}
                  >
                    {type === 'estimate'
                      ? t('invoice.estimate')
                      : type === 'credit_memo'
                        ? t('invoice.creditMemo')
                        : t('invoice.invoice')}
                  </button>
                ))}
              </div>
              {!customer?.id && !order.customerId && (
                <p className="text-[10px] text-amber-700 mt-1.5 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1">
                  Link a customer on the order to save this under their account.
                </p>
              )}
            </div>

            {/* Quantity Basis Toggle */}
            {!canEditLines && (
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1.5 uppercase tracking-wider text-[10px]">
                Quantity Basis
              </label>
              <div className="grid grid-cols-3 gap-1 bg-gray-200/60 p-1 rounded-lg">
                {(['ordered', 'pulled', 'loaded'] as const).map((basis) => (
                  <button
                    key={basis}
                    type="button"
                    onClick={() => setQtyBasis(basis)}
                    className={`py-1 text-[10px] font-bold rounded-md capitalize transition-all ${
                      qtyBasis === basis
                        ? 'bg-ink-700 text-white shadow-sm'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-300/40'
                    }`}
                  >
                    {basis === 'ordered' ? t('invoice.ordered') : basis === 'pulled' ? t('invoice.pulled') : t('invoice.loaded')}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-500 mt-1 italic">
                Invoicing based on {qtyBasis === 'ordered' ? 'original customer order counts' : qtyBasis === 'pulled' ? 'items delivered/pulled from nursery' : 'items loaded onto the truck'}.
              </p>
            </div>
            )}

            {/* Invoice Number */}
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {docLabel} Number
              </label>
              <input
                type="text"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-semibold text-gray-800"
              />
            </div>

            {/* Customer PO Number + referenced invoice (credit memos) */}
            <div className={isCreditMemo ? 'grid grid-cols-1 gap-2' : ''}>
              <div>
                <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                  Customer P.O. #
                </label>
                <input
                  type="text"
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  placeholder={t('invoice.customerPoPlaceholder')}
                  className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-semibold text-gray-800"
                />
                {!isCreditMemo && (
                  <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                    Prints on the invoice & BOL, and syncs to the QuickBooks P.O. field.
                  </p>
                )}
              </div>
              {isCreditMemo && (
                <div>
                  <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                    {t('invoice.referencedInvoice')}
                  </label>
                  <input
                    type="text"
                    value={referencedInvoiceNumber}
                    onChange={(e) => setReferencedInvoiceNumber(e.target.value)}
                    placeholder={t('invoice.referencedInvoicePlaceholder')}
                    className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-semibold text-gray-800"
                  />
                </div>
              )}
            </div>

            {/* Sales Rep (profit attribution) */}
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Sales Rep
              </label>
              <select
                value={salesRep}
                onChange={(e) => setSalesRep(e.target.value)}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-semibold text-gray-800"
              >
                <option value="">{t('invoice.unassigned')}</option>
                {salesRepOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {salesRep && !salesRepOptions.includes(salesRep) && (
                  <option value={salesRep}>{salesRep}</option>
                )}
              </select>
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                Credits this invoice&apos;s profit to the rep in Reports. Options are Owners, Admins,
                and team members with the Sales role.
              </p>
            </div>

            {/* Date and Terms */}
            <div className={`grid gap-2 ${isCreditMemo ? 'grid-cols-1' : 'grid-cols-2'}`}>
              <div>
                <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                  {isCreditMemo ? t('invoice.creditMemoDate') : 'Invoice Date'}
                </label>
                <input
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
                />
              </div>
              {!isCreditMemo && (
              <div>
                <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                  Terms
                </label>
                <select
                  value={paymentTerms}
                  onChange={(e) => setPaymentTerms(e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
                >
                  <option value="Due on Receipt">Due on Receipt</option>
                  <option value="COD">COD (Pickup)</option>
                  <option value="Net 15">Net 15</option>
                  <option value="Net 30">Net 30</option>
                  <option value="Net 45">Net 45</option>
                </select>
              </div>
              )}
            </div>

            {/* Due Date */}
            {!isCreditMemo && (
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Due Date
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
              />
            </div>
            )}

            {/* Financial Adjustments */}
            <div
              id="invoice-charges"
              className="bg-slate-100 p-2.5 rounded-xl space-y-2 border border-slate-200 scroll-mt-4"
            >
              <span className="block font-mono font-bold text-[9px] text-gray-400 uppercase tracking-widest">{t('invoice.charges')}</span>
              
              {/* Freight Charge */}
              {!isCreditMemo && (
              <div>
                <label className="flex items-center justify-between font-bold text-gray-600 mb-0.5">
                  <span>{t('invoice.freight')}</span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-gray-400">
                    <DollarSign className="h-3 w-3" />
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={freightCharge || ''}
                    placeholder="0.00"
                    onChange={(e) => setFreightCharge(Number(e.target.value) || 0)}
                    className="w-full pl-7 pr-3 py-1 border border-gray-200 rounded-lg focus:outline-none focus:border-ink-500 bg-white font-mono font-medium"
                  />
                </div>
              </div>
              )}

              {/* Tax Rate */}
              <div>
                <label className="flex items-center justify-between font-bold text-gray-600 mb-0.5">
                  <span>{t('invoice.taxRate')}</span>
                  <button 
                    onClick={() => setTaxRate(taxRate === 0 ? 4.45 : 0)}
                    className="text-[9px] text-ink-700 hover:underline"
                  >
                    {taxRate === 0 ? t('invoice.useTax') : t('invoice.exempt')}
                  </button>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-gray-400">
                    <Percent className="h-3 w-3" />
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={taxRate}
                    onChange={(e) => setTaxRate(Number(e.target.value) || 0)}
                    className="w-full pl-7 pr-3 py-1 border border-gray-200 rounded-lg focus:outline-none focus:border-ink-500 bg-white font-mono font-medium"
                  />
                </div>
              </div>

              {/* Discount */}
              {!isCreditMemo && (
              <div>
                <label className="flex items-center justify-between font-bold text-gray-600 mb-0.5">
                  <span>{t('invoice.discount')}</span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-gray-400">
                    <DollarSign className="h-3 w-3" />
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={discount || ''}
                    placeholder="0.00"
                    onChange={(e) => setDiscount(Number(e.target.value) || 0)}
                    className="w-full pl-7 pr-3 py-1 border border-gray-200 rounded-lg focus:outline-none focus:border-ink-500 bg-white font-mono font-medium"
                  />
                </div>
              </div>
              )}
            </div>

            {/* Invoice Notes */}
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {docLabel} Footer Notes
              </label>
              <textarea
                rows={3}
                value={invoiceNotes}
                onChange={(e) => setInvoiceNotes(e.target.value)}
                className="w-full px-2.5 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white text-[11px] leading-relaxed"
              />
            </div>

            {/* Quick Actions */}
            <div className="pt-2">
              <button
                type="button"
                onClick={handleResetPrices}
                className="text-ink-700 hover:text-ink-950 font-bold flex items-center gap-1 hover:underline text-[10px]"
              >
                <RefreshCw className="h-3 w-3" />
                <span>{t('invoice.resetPrices')}</span>
              </button>
            </div>
          </div>

          <div className="pt-3 border-t border-gray-200 flex flex-col space-y-2">
            <button
              onClick={handleSaveInvoice}
              disabled={isSaving}
              className={`w-full py-2.5 px-4 rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2 ${
                saveSuccess
                  ? 'bg-ink-600 text-white'
                  : 'bg-slate-800 hover:bg-slate-900 text-white'
              }`}
            >
              {saveSuccess ? (
                <>
                  <Check className="h-4 w-4" />
                  <span>{t('invoice.savedToCustomer')}</span>
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  <span>
                    {isSaving
                      ? t('invoice.saving')
                      : savedDocumentId
                        ? t('invoice.updateDoc', { docLabel })
                        : customer?.id || order.customerId
                          ? `Save ${docLabel} to Customer`
                          : t('invoice.savePricing')}
                  </span>
                </>
              )}
            </button>

            {savedDocumentId && (
              <button
                type="button"
                onClick={() => void handleDeleteDocument()}
                disabled={isSaving}
                className="w-full py-2.5 px-4 rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2 bg-white hover:bg-rose-50 text-rose-700 border border-rose-200 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                <span>{t('invoice.deleteDoc', { docLabel })}</span>
              </button>
            )}

            {/* Email Invoice Panel */}
            <div className="border-t border-gray-200 pt-3">
              <button
                type="button"
                onClick={() => setShowEmailPanel(!showEmailPanel)}
                className={`w-full py-2.5 px-4 rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2 border ${
                  showEmailPanel
                    ? 'bg-ink-50 border-ink-300 text-ink-800'
                    : 'bg-white border-gray-200 hover:bg-slate-50 text-gray-700'
                }`}
              >
                <Mail className="h-4 w-4" />
                <span>{showEmailPanel ? t('invoice.hideEmail') : t('invoice.emailCustomer', { docLabel })}</span>
              </button>

              {showEmailPanel && (
                <div className="mt-3 p-3 bg-ink-50/45 border border-ink-100 rounded-2xl space-y-3.5 text-xs">
                  <div>
                    <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                      {t('invoice.toEmail')}
                    </label>
                    <input
                      type="email"
                      value={customerEmail}
                      onChange={(e) => setCustomerEmail(e.target.value)}
                      placeholder={t('invoice.emailPlaceholder')}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-semibold text-gray-800 text-xs"
                    />
                  </div>

                  <EmailCcSection
                    value={ccEmails}
                    onChange={setCcEmails}
                    toEmail={customerEmail}
                    disabled={isSendingEmail}
                  />

                  {tenantId ? (
                    <OutboundReplySelect
                      tenantId={tenantId}
                      value={selectedReplyTo}
                      onChange={(email) => setSelectedReplyTo(email)}
                      disabled={isSendingEmail}
                    />
                  ) : null}

                  <div>
                    <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                      Email Subject
                    </label>
                    <input
                      type="text"
                      value={emailSubject}
                      onChange={(e) => setEmailSubject(e.target.value)}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-semibold text-gray-800 text-xs"
                    />
                  </div>

                  {order.emailSentAt && (
                    <div className="bg-ink-100/40 p-2.5 rounded-xl text-[10px] text-ink-800 font-medium flex items-center space-x-1.5 border border-ink-200/30">
                      <Check className="h-3.5 w-3.5 shrink-0" />
                      <span>Last sent: {new Date(order.emailSentAt.split(' (')[0]).toLocaleDateString()} {new Date(order.emailSentAt.split(' (')[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  )}

                  {emailSentStatus === 'success' && (
                    <div className="p-3 bg-ink-50 border border-ink-200 text-ink-800 rounded-xl text-[10px] leading-normal font-medium">
                      <p className="font-bold flex items-center mb-0.5 text-ink-900"><Check className="h-3.5 w-3.5 mr-1 text-ink-700" /> {docLabel} Sent Successfully!</p>
                      <p className="text-[9px] text-ink-700">{t('invoice.emailSentBody', { docLabel: docLabel.toLowerCase() })}</p>
                      {emailQbNote && (
                        <p className="text-[9px] text-ink-700 mt-1">{emailQbNote}</p>
                      )}
                    </div>
                  )}

                  {emailSentStatus === 'error_smtp' && (
                    <div className="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl text-[10px] leading-normal">
                      <p className="font-bold flex items-center mb-1 text-amber-900"><AlertTriangle className="h-3.5 w-3.5 mr-1 text-amber-600" /> Nursery Email Not Configured</p>
                      <p className="text-[9px] text-amber-700 mb-2 leading-relaxed">
                        {emailErrorMessage ||
                          'Open Team → Outbound email and add this nursery’s reply-to address. Make sure RESEND_API_KEY is set in Railway.'}
                      </p>
                      <button
                        onClick={handleOpenMailClient}
                        className="w-full py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded-lg text-[9px] font-black transition-all flex items-center justify-center space-x-1"
                      >
                        <Mail className="h-3 w-3" />
                        <span>{t('invoice.openMailto')}</span>
                      </button>
                    </div>
                  )}

                  {emailSentStatus === 'error_general' && (
                    <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl text-[10px] leading-normal">
                      <p className="font-bold flex items-center mb-0.5 text-rose-900"><AlertTriangle className="h-3.5 w-3.5 mr-1 text-rose-600" /> Error Dispatching Email</p>
                      <p className="text-[9px] text-rose-700 mb-2">{emailErrorMessage}</p>
                      <button
                        onClick={handleOpenMailClient}
                        className="w-full py-1.5 bg-slate-700 hover:bg-slate-800 text-white rounded-lg text-[9px] font-bold transition-all flex items-center justify-center space-x-1"
                      >
                        <span>{t('invoice.fallbackMail')}</span>
                      </button>
                    </div>
                  )}

                  {tenantId &&
                    (useQboPayLinks || useStripePayLinks) &&
                    documentType === 'invoice' &&
                    !isPaid && (
                    <label className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50/70 p-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includePayLinkInEmail}
                        onChange={(e) => setIncludePayLinkInEmail(e.target.checked)}
                        className="mt-0.5 h-3.5 w-3.5 accent-sky-700"
                      />
                      <span className="text-[10px] font-bold text-sky-900 leading-relaxed">
                        {t('invoice.includePay')}
                        <span className="block font-medium text-sky-700">
                          {t('invoice.includePayHint')}
                        </span>
                      </span>
                    </label>
                  )}

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      onClick={handleSendEmailServer}
                      disabled={isSendingEmail}
                      className="py-2 px-2.5 bg-ink-800 hover:bg-ink-900 text-white rounded-xl text-[10px] font-black shadow-sm transition-all flex items-center justify-center space-x-1"
                    >
                      <Send className="h-3 w-3" />
                      <span>{isSendingEmail ? t('invoice.sending') : t('invoice.sendDirect')}</span>
                    </button>

                    <button
                      onClick={handleOpenMailClient}
                      className="py-2 px-2.5 bg-white border border-gray-200 hover:bg-slate-100 text-gray-700 rounded-xl text-[10px] font-black shadow-sm transition-all flex items-center justify-center space-x-1"
                    >
                      <Mail className="h-3 w-3" />
                      <span>{t('invoice.useMailApp')}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={handleExportPdf}
              className="w-full py-2.5 px-4 bg-ink-800 hover:bg-ink-900 text-white rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2"
            >
              <Download className="h-4 w-4" />
              <span>{t('invoice.exportPdf')}</span>
            </button>

            {documentType === 'invoice' && !isPaid && (
              <button
                type="button"
                onClick={() => {
                  if (!savedDocumentId || !paymentDocument) {
                    alert(t('invoice.saveInvoiceFirst'));
                    return;
                  }
                  setShowMarkPaid(true);
                }}
                disabled={!savedDocumentId}
                className="w-full py-2.5 px-4 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2"
                title={savedDocumentId ? t('invoice.markAsPaid') : t('invoice.saveInvoiceFirst')}
              >
                <Check className="h-4 w-4" />
                <span>{t('invoice.markAsPaid')}</span>
              </button>
            )}

            {tenantId &&
              documentType === 'invoice' &&
              !isPaid &&
              (useQboPayLinks || useStripePayLinks || Boolean(paymentDocument?.qboInvoiceId)) && (
              <button
                type="button"
                onClick={() => void handleRefreshPaymentStatus()}
                disabled={isRefreshingPayment || !savedDocumentId}
                className="w-full py-2.5 px-4 bg-white hover:bg-sky-50 text-sky-800 border border-sky-200 rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshingPayment ? 'animate-spin' : ''}`} />
                <span>
                  {isRefreshingPayment
                    ? useQboPayLinks || paymentDocument?.qboInvoiceId
                      ? t('invoice.checkingQbPayment')
                      : t('invoice.checkingStripe')
                    : t('invoice.refreshPayment')}
                </span>
              </button>
            )}

            <div className="border-t border-gray-200 pt-3 space-y-2">
              {tenantId &&
                (useQboPayLinks || useStripePayLinks) &&
                documentType === 'invoice' && (
                <button
                  type="button"
                  onClick={() => void handleCreatePayLink()}
                  disabled={isCreatingPayLink || !savedDocumentId || isPaid}
                  className="w-full py-2.5 px-4 bg-sky-700 hover:bg-sky-800 disabled:opacity-50 text-white rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2"
                  title={
                    isPaid
                      ? t('invoice.alreadyPaidTitle')
                      : savedDocumentId
                        ? t('invoice.createPayLink')
                        : t('invoice.saveFirst')
                  }
                >
                  <DollarSign className="h-4 w-4" />
                  <span>
                    {isPaid
                      ? t('invoice.invoicePaidBtn')
                      : isCreatingPayLink
                        ? t('invoice.creatingPayLink')
                        : payLinkMessage || t('invoice.createPayLink')}
                  </span>
                </button>
              )}

              {activePayLinkUrl && !isPaid && (
                <p className="text-[10px] text-sky-800 bg-sky-50 border border-sky-100 rounded-lg px-2.5 py-2 leading-relaxed break-all">
                  {t('invoice.payLinkReadyCustomer')}
                </p>
              )}

              {tenantId && canUseQuickbooks && (
                <button
                  type="button"
                  onClick={() => void handlePushToQuickbooks()}
                  disabled={isPushingQb || !savedDocumentId}
                  className="w-full py-2.5 px-4 bg-white hover:bg-sky-50 text-sky-900 border border-sky-200 disabled:opacity-50 rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2"
                  title={
                    savedDocumentId
                      ? t('invoice.saveFirstQb')
                      : 'Save to customer first'
                  }
                >
                  <Link2 className="h-4 w-4" />
                  <span>
                    {isPushingQb
                      ? t('invoice.pushingQb')
                      : qbPushMessage || t('invoice.pushQb')}
                  </span>
                </button>
              )}
              {tenantId &&
                canUseQuickbooks &&
                isPaid &&
                (paymentDocument?.qboInvoiceId || liveDocument?.qboInvoiceId) &&
                !(paymentDocument?.qboPaymentId || liveDocument?.qboPaymentId) && (
                  <button
                    type="button"
                    disabled={isPushingQb || !savedDocumentId}
                    onClick={() =>
                      void (async () => {
                        if (!savedDocumentId) return;
                        setIsPushingQb(true);
                        try {
                          const msg = await syncPaymentToQuickbooksIfPossible(savedDocumentId);
                          if (msg) alert(msg);
                        } finally {
                          setIsPushingQb(false);
                        }
                      })()
                    }
                    className="w-full py-2 px-4 bg-sky-50 hover:bg-sky-100 border border-sky-200 text-sky-900 rounded-xl text-xs font-bold transition-all"
                  >
                    {t('invoice.syncPaymentToQb')}
                  </button>
                )}
            </div>

            {/* Internal Cost & Profit (never printed or emailed to the customer) */}
            {canViewProfit && !isCreditMemo && (
              <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="font-black uppercase tracking-wider text-[10px] text-indigo-800 flex items-center gap-1">
                    <TrendingUp className="h-3.5 w-3.5" /> Cost & Profit
                  </p>
                  <span className="text-[8px] font-bold uppercase text-indigo-400 tracking-wide">
                    Internal only
                  </span>
                </div>
                <div className="space-y-2">
                  {workingItems.map((item) => {
                    const qty = getItemQty(item);
                    const price =
                      itemPrices[item.id] !== undefined
                        ? itemPrices[item.id]
                        : getDefaultPriceForSize(item.containerSize);
                    const cost = itemCosts[item.id] ?? 0;
                    const lineProfit = item.unavailable ? 0 : (price - cost) * qty;
                    const sizeLabel = String(item.containerSize || '').trim();
                    return (
                      <div
                        key={item.id}
                        className={`rounded-lg border border-indigo-100 bg-white/70 px-2 py-1.5 space-y-1${item.unavailable ? ' opacity-40' : ''}`}
                      >
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold text-gray-800 leading-snug break-words">
                            {item.plantName || '—'}
                            {item.unavailable ? (
                              <span className="ml-1 text-[9px] font-bold uppercase text-rose-600">
                                ({t('invoice.notAvailable')})
                              </span>
                            ) : null}
                          </p>
                          <p className="text-[10px] font-mono font-bold text-slate-500 mt-0.5">
                            {sizeLabel ? sizeLabel : t('invoice.potSize')}
                            <span className="text-slate-300 mx-1">·</span>
                            Qty {qty}
                            <span className="text-slate-300 mx-1">·</span>
                            ${price.toFixed(2)} ea
                          </p>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[9px] font-bold uppercase tracking-wide text-indigo-500">
                            Cost
                          </span>
                          <div className="inline-flex items-center gap-1.5">
                            <div className="inline-flex items-center">
                              <span className="text-[9px] text-slate-400 font-mono font-bold mr-0.5">$</span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={cost || ''}
                                placeholder={t('invoice.costPlaceholder')}
                                onChange={(e) => handleCostChange(item.id, Number(e.target.value))}
                                className="w-16 font-mono font-bold text-right text-indigo-800 bg-white border border-indigo-200 focus:border-indigo-500 focus:outline-none px-1 py-0.5 rounded"
                              />
                            </div>
                            <span
                              className={`min-w-[3.5rem] text-right font-mono font-bold text-[10px] ${
                                lineProfit >= 0 ? 'text-ink-700' : 'text-rose-600'
                              }`}
                              title="Line profit"
                            >
                              ${lineProfit.toFixed(2)}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="pt-2 border-t border-indigo-200 space-y-1 text-[10px] font-mono">
                  <div className="flex justify-between">
                    <span className="text-gray-500 font-medium">Revenue:</span>
                    <span className="font-bold text-gray-900">${subtotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500 font-medium">Total Cost:</span>
                    <span className="font-bold text-gray-900">${totalCost.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between pt-1 border-t border-indigo-100">
                    <span className="font-black uppercase text-indigo-800">Profit:</span>
                    <span
                      className={`font-black ${
                        totalProfit >= 0 ? 'text-ink-700' : 'text-rose-600'
                      }`}
                    >
                      ${totalProfit.toFixed(2)}
                      <span className="ml-1 text-[9px] font-bold text-gray-400">
                        ({profitMargin.toFixed(1)}%)
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            )}

            <button
              onClick={onClose}
              className="w-full py-2 bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 rounded-xl text-xs font-bold transition-all flex items-center justify-center"
            >
              Close Window
            </button>
          </div>
        </div>

        {/* Right Side / Document Preview (Becomes full-page on print) */}
        <div className="flex-none md:flex-1 bg-white p-4 md:p-10 flex flex-col md:min-h-0 print:p-0 order-1 md:order-2">
          
          {/* Action header inside modal (Hidden during print) */}
          <div className="flex justify-between items-center pb-3 mb-4 border-b border-gray-150 print:hidden">
            <div className="min-w-0 pr-2">
              <h2 className="text-base font-black text-gray-900 flex items-center">
                <FileCheck className="h-5 w-5 mr-1.5 text-ink-700 shrink-0" />
                {docLabel} Preview
              </h2>
              <p className="text-[10px] text-gray-500 mt-0.5 font-sans">
                Real-time generated invoice for <span className="font-bold">{order.customerName}</span>. Type prices directly into the invoice sheet below to customize!
              </p>
              {!isCreditMemo && (
                <a
                  href="#invoice-charges"
                  className="mt-1.5 inline-flex md:hidden text-[11px] font-bold text-ink-700 hover:text-ink-900 underline underline-offset-2"
                >
                  Edit freight, tax & discount ↓
                </a>
              )}
            </div>
            <div className="flex items-center space-x-2 shrink-0">
              <button
                onClick={handleExportPdf}
                className="p-2 bg-ink-50 border border-ink-100 rounded-xl text-ink-800 hover:bg-ink-100 transition-colors"
                title={t('invoice.exportPdf')}
              >
                <Download className="h-4 w-4" />
              </button>
              <button
                onClick={onClose}
                className="p-2 hover:bg-gray-100 border border-gray-200 rounded-xl text-gray-500 hover:text-gray-900 transition-colors"
                title={t('invoice.closeWindowTitle')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Printable Document Sheet — natural height on mobile; scroll pane on desktop */}
          <div className="md:flex-1 md:min-h-0 md:overflow-y-auto md:pr-2 print:overflow-visible print:pr-0">
            <div
              ref={printRef}
              className="border border-gray-300 p-3 sm:p-6 rounded-lg bg-white shadow-inner max-w-4xl mx-auto print:border-none print:shadow-none print:p-0 text-gray-900 font-sans leading-normal md:overflow-x-auto print:overflow-visible"
            >
              
              {/* STYLE TAG FOR PRINT WORKAROUNDS */}
              <style dangerouslySetInnerHTML={{__html: `
                @media print {
                  body {
                    color: #000000 !important;
                    background: #ffffff !important;
                  }
                  .print\\:hidden {
                    display: none !important;
                  }
                  .print\\:border-none {
                    border: none !important;
                  }
                  .print\\:p-0 {
                    padding: 0 !important;
                  }
                  .print\\:shadow-none {
                    box-shadow: none !important;
                  }
                  .price-input {
                    border: none !important;
                    background: transparent !important;
                    padding: 0 !important;
                    width: auto !important;
                    text-align: right !important;
                  }
                  .price-input-prefix {
                    display: none !important;
                  }
                }
              `}} />

              {/* Document Header */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-3 border-b border-gray-300">
                <div className="flex items-start gap-3">
                  {logoSrc ? (
                    <img
                      src={logoSrc}
                      alt={`${nurseryName} logo`}
                      className="h-14 w-14 sm:h-16 sm:w-16 object-contain rounded-xl border border-ink-100 bg-white shadow-sm shrink-0"
                    />
                  ) : null}
                  <div className="min-w-0">
                    <h1 className="text-xl font-black tracking-tight text-ink-950 uppercase leading-none">
                      {nurseryName}
                    </h1>
                    <p className="text-xs text-gray-500 font-mono font-bold mt-1 uppercase tracking-widest">
                      Wholesale Nursery
                    </p>
                  </div>
                </div>
                
                <div className="sm:text-right flex flex-col justify-between items-start sm:items-end">
                  <div className="border-2 border-ink-900/10 rounded-xl p-3 px-4 bg-ink-50/20 inline-block text-left sm:text-right">
                    <span className="block text-[10px] font-black text-ink-800 font-mono uppercase tracking-widest mb-0.5">
                      {docLabelUpper}
                    </span>
                    <span className="text-xl font-mono font-black text-gray-950 block">
                      {invoiceNumber}
                    </span>
                    {isPaid && (
                      <span className="mt-2 inline-flex items-center rounded-full bg-emerald-700 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-white">
                        Paid
                      </span>
                    )}
                    {!isPaid && paymentStatus === 'pending' && (
                      <span className="mt-2 inline-flex items-center rounded-full bg-amber-500 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-white">
                        Payment pending
                      </span>
                    )}
                  </div>
                  
                  <div className="mt-4 text-left sm:text-right font-mono text-[11px] space-y-0.5">
                    <p className="text-gray-400 font-bold uppercase text-[9px] tracking-wider mb-1">{docLabel} Details</p>
                    <p className="text-gray-800">
                      <span className="font-bold text-gray-500">Date:</span> {new Date(invoiceDate).toLocaleDateString(undefined, { dateStyle: 'long' })}
                    </p>
                    {poNumber.trim() && (
                      <p className="text-gray-800">
                        <span className="font-bold text-gray-500">P.O. #:</span> <span className="font-bold text-gray-950">{poNumber}</span>
                      </p>
                    )}
                    {isCreditMemo && referencedInvoiceNumber.trim() && (
                      <p className="text-gray-800">
                        <span className="font-bold text-gray-500">{t('invoice.referencedInvoiceShort')}:</span>{' '}
                        <span className="font-bold text-gray-950">{referencedInvoiceNumber}</span>
                      </p>
                    )}
                    {!isCreditMemo && (
                      <>
                    <p className="text-gray-800">
                      <span className="font-bold text-gray-500">Terms:</span> <span className="font-bold text-ink-800">{paymentTerms}</span>
                    </p>
                    <p className="text-gray-800">
                      <span className="font-bold text-gray-500">Due Date:</span> <span className="font-bold">{dueDate ? new Date(dueDate).toLocaleDateString(undefined, { dateStyle: 'long' }) : t('invoice.uponReceipt')}</span>
                    </p>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Bill To & Ship To section */}
              <div className={`grid grid-cols-1 gap-4 py-3 border-b border-gray-300 ${isCreditMemo ? '' : 'md:grid-cols-2'}`}>
                <div>
                  <h3 className="text-xs font-black font-mono uppercase text-ink-800 tracking-wider mb-2">
                    Bill To Customer:
                  </h3>
                  <div className="text-xs text-gray-800 space-y-1">
                    {/* Inline Editable Customer Name */}
                    <input
                      type="text"
                      value={billToName}
                      onChange={(e) => setBillToName(e.target.value)}
                      className="font-bold text-sm text-gray-950 bg-transparent hover:bg-slate-50 border-b border-transparent focus:border-ink-600 focus:bg-white focus:outline-none w-full p-0.5 rounded transition-all print:border-none print:p-0 print:font-black"
                      placeholder={t('invoice.customerNamePlaceholder')}
                    />
                    <textarea
                      rows={2}
                      value={billToAddress}
                      onChange={(e) => setBillToAddress(e.target.value)}
                      className="w-full text-xs text-gray-600 bg-transparent hover:bg-slate-50 border border-transparent focus:border-ink-600 focus:bg-white focus:outline-none p-0.5 rounded leading-normal resize-none font-sans font-medium mt-1 print:border-none print:p-0"
                      placeholder={t('invoice.billingAddressPlaceholder')}
                    />
                  </div>
                </div>
                
                {!isCreditMemo && (
                <div>
                  <h3 className="text-xs font-black font-mono uppercase text-ink-800 tracking-wider mb-2">
                    Shipping Origin & Carrier:
                  </h3>
                  <div className="text-xs text-gray-800 space-y-1 font-mono">
                    <p><span className="font-bold text-gray-400">Shipper:</span> {nurseryName}</p>
                    <p className="whitespace-pre-line">
                      <span className="font-bold text-gray-400">Origin:</span>{' '}
                      {nurseryAddress || t('invoice.defaultOrigin')}
                    </p>
                    <p>
                      <span className="font-bold text-gray-400">Cargo Basis:</span>{' '}
                      <span className="font-bold text-ink-900 uppercase">
                        {qtyBasis === 'ordered' ? t('invoice.orderedQuantities') : qtyBasis === 'pulled' ? t('invoice.deliveredPulledCounts') : t('invoice.loadedCounts')}
                      </span>
                    </p>
                  </div>
                </div>
                )}
              </div>

              {/* Line items — stacked cards on mobile, table on desktop/print */}
              <div className="py-3 md:overflow-x-auto -mx-1 px-1">
                <div className="md:hidden print:hidden space-y-2.5">
                  {workingItems.map((item) => {
                    const qty = getItemQty(item);
                    const price =
                      itemPrices[item.id] !== undefined
                        ? itemPrices[item.id]
                        : getDefaultPriceForSize(item.containerSize);
                    const unavailable = Boolean(item.unavailable);
                    const total = unavailable ? 0 : qty * price;
                    const subs = itemSubstitutes[item.id] ?? item.substitutes ?? '';

                    return (
                      <div
                        key={item.id}
                        className={`rounded-lg border p-2.5 ${
                          unavailable
                            ? 'border-slate-200 bg-slate-50 text-slate-400'
                            : 'border-gray-200 bg-white text-gray-800'
                        }`}
                      >
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            {canEditLines ? (
                              <input
                                type="text"
                                value={item.plantName}
                                onChange={(e) =>
                                  updateDraftLine(item.id, { plantName: e.target.value })
                                }
                                placeholder={t('invoice.plantVarietyName')}
                                className={`w-full font-black bg-transparent border-b border-gray-200 focus:border-ink-600 focus:outline-none py-0.5 break-words ${
                                  unavailable
                                    ? 'text-slate-400 line-through'
                                    : 'text-gray-950'
                                }`}
                              />
                            ) : (
                              <p
                                className={`font-black break-words leading-snug ${
                                  unavailable
                                    ? 'text-slate-400 line-through'
                                    : 'text-gray-950'
                                }`}
                              >
                                {item.plantName}
                              </p>
                            )}
                            {unavailable && (
                              <span className="block text-[10px] font-bold uppercase tracking-wide text-rose-600 mt-0.5">
                                {t('invoice.notAvailable')}
                              </span>
                            )}
                            {item.notes && (
                              <span className="block text-[10px] text-gray-400 font-normal italic mt-0.5 break-words">
                                Note: {item.notes}
                              </span>
                            )}
                            {!canEditLines && subs.trim() ? (
                              <span className="block text-[10px] text-slate-500 font-normal italic mt-0.5 break-words">
                                {t('invoice.possibleSubs')}: {subs.trim()}
                              </span>
                            ) : null}
                          </div>
                          {canEditLines && (
                            <button
                              type="button"
                              onClick={() => removeDraftLine(item.id)}
                              disabled={workingItems.length <= 1}
                              className="p-1 text-slate-400 hover:text-rose-600 disabled:opacity-30 shrink-0"
                              title={t('invoice.removeLine')}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          )}
                        </div>

                        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
                          <label className="block min-w-0">
                            <span className="text-[9px] font-bold uppercase tracking-wide text-gray-500">
                              {t('invoice.potSize')}
                            </span>
                            {canEditLines ? (
                              <input
                                type="text"
                                value={item.containerSize}
                                onChange={(e) =>
                                  updateDraftLine(item.id, { containerSize: e.target.value })
                                }
                                placeholder={t('invoice.potSize')}
                                className={`mt-0.5 w-full font-mono font-bold bg-slate-50 border border-gray-200 rounded px-2 py-1 focus:border-ink-600 focus:outline-none ${
                                  unavailable ? 'text-slate-400' : 'text-gray-700'
                                }`}
                              />
                            ) : (
                              <p className="mt-0.5 font-mono font-bold text-gray-700">
                                {item.containerSize || '—'}
                              </p>
                            )}
                          </label>
                          <label className="block min-w-0">
                            <span className="text-[9px] font-bold uppercase tracking-wide text-gray-500">
                              Quantity
                            </span>
                            {canEditLines ? (
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={qty || ''}
                                onChange={(e) =>
                                  updateDraftLine(item.id, {
                                    quantity: Math.max(0, Number(e.target.value) || 0)
                                  })
                                }
                                className={`mt-0.5 w-full font-mono font-bold bg-slate-50 border border-gray-200 rounded px-2 py-1 text-center focus:border-ink-600 focus:outline-none ${
                                  unavailable ? 'text-slate-400' : 'text-gray-900'
                                }`}
                              />
                            ) : (
                              <p className="mt-0.5 font-mono font-bold text-gray-900 text-center">
                                {qty}
                              </p>
                            )}
                          </label>
                          <label className="block min-w-0">
                            <span className="text-[9px] font-bold uppercase tracking-wide text-gray-500">
                              {t('invoice.unitPrice')}
                            </span>
                            <div
                              className={`mt-0.5 inline-flex w-full items-center bg-ink-50/40 border border-gray-200 rounded px-2 py-1 ${
                                unavailable ? 'opacity-40' : ''
                              }`}
                            >
                              <span className="text-[10px] text-slate-400 font-mono font-bold mr-1">
                                $
                              </span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={price}
                                onChange={(e) => handlePriceChange(item.id, Number(e.target.value))}
                                className="w-full min-w-0 font-mono font-bold text-ink-800 bg-transparent focus:outline-none"
                              />
                            </div>
                          </label>
                          <div className="block min-w-0">
                            <span className="text-[9px] font-bold uppercase tracking-wide text-gray-500">
                              Total
                            </span>
                            <p
                              className={`mt-0.5 font-mono font-black text-right pr-1 ${
                                unavailable ? 'text-slate-400' : 'text-gray-950'
                              }`}
                            >
                              {unavailable ? '—' : `$${total.toFixed(2)}`}
                            </p>
                          </div>
                        </div>

                        {documentType === 'estimate' && canEditLines && (
                          <div className="mt-2 pt-2 border-t border-gray-100 space-y-2">
                            <div className="flex flex-wrap gap-x-4 gap-y-1">
                              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={unavailable}
                                  onChange={(e) =>
                                    updateDraftLine(item.id, { unavailable: e.target.checked })
                                  }
                                  className="rounded border-slate-300 text-rose-600 focus:ring-rose-500"
                                />
                                <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">
                                  {t('invoice.markUnavailable')}
                                </span>
                              </label>
                            </div>
                            <label className="block">
                              <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400">
                                {t('invoice.possibleSubs')}
                              </span>
                              <input
                                type="text"
                                value={subs}
                                onChange={(e) =>
                                  setItemSubstitutes((prev) => ({
                                    ...prev,
                                    [item.id]: e.target.value
                                  }))
                                }
                                placeholder={t('invoice.possibleSubsPlaceholder')}
                                className="mt-0.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-700 focus:outline-none focus:ring-1 focus:ring-ink-600 focus:bg-white"
                              />
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {canEditLines && (
                    <button
                      type="button"
                      onClick={addDraftLine}
                      className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-ink-700 hover:text-ink-900"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {isCreditMemo ? t('invoice.addCreditLine') : t('invoice.addEstimateLine')}
                    </button>
                  )}
                </div>

                <table className="hidden md:table print:table w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b-2 border-gray-300 text-gray-500 text-[9px] font-black font-mono uppercase tracking-widest">
                      <th className="pb-1 text-left">{t('invoice.plantVarietyName')}</th>
                      <th className="pb-1 text-center w-28">{t('invoice.potSize')}</th>
                      <th className="pb-1 text-center w-20">Quantity</th>
                      <th className="pb-1 text-right w-28">{t('invoice.unitPrice')}</th>
                      <th className="pb-1 text-right w-24">Total</th>
                      {canEditLines && <th className="pb-1 w-10 print:hidden" />}
                    </tr>
                  </thead>
                  <tbody>
                    {workingItems.map((item) => {
                      const qty = getItemQty(item);
                      const price = itemPrices[item.id] !== undefined ? itemPrices[item.id] : getDefaultPriceForSize(item.containerSize);
                      const unavailable = Boolean(item.unavailable);
                      const total = unavailable ? 0 : qty * price;
                      const subs = itemSubstitutes[item.id] ?? item.substitutes ?? '';

                      return (
                        <tr
                          key={item.id}
                          className={`border-b border-gray-200 text-xs font-medium ${
                            unavailable
                              ? 'bg-slate-50 text-slate-400'
                              : 'text-gray-800'
                          }`}
                        >
                          <td className="py-1.5">
                            {canEditLines ? (
                              <input
                                type="text"
                                value={item.plantName}
                                onChange={(e) =>
                                  updateDraftLine(item.id, { plantName: e.target.value })
                                }
                                placeholder={t('invoice.plantVarietyName')}
                                className={`w-full font-black bg-transparent hover:bg-slate-50 border-b border-transparent focus:border-ink-600 focus:outline-none print:border-none ${
                                  unavailable
                                    ? 'text-slate-400 line-through'
                                    : 'text-gray-950'
                                }`}
                              />
                            ) : (
                              <span
                                className={`font-black ${
                                  unavailable
                                    ? 'text-slate-400 line-through'
                                    : 'text-gray-950'
                                }`}
                              >
                                {item.plantName}
                              </span>
                            )}
                            {unavailable && (
                              <span className="block text-[10px] font-bold uppercase tracking-wide text-rose-600 mt-0.5 no-underline">
                                {t('invoice.notAvailable')}
                              </span>
                            )}
                            {(() => {
                              const photo = linePhotoUrl(item);
                              if (!photo) return null;
                              return (
                                <a
                                  href={photo}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 mt-0.5 text-[10px] font-bold text-ink-700 hover:underline"
                                >
                                  <ImageIcon className="h-3 w-3" />
                                  {t('invoice.viewPhoto')}
                                </a>
                              );
                            })()}
                            {item.notes && (
                              <span className="block text-[10px] text-gray-400 font-normal italic mt-0.5">
                                Note: {item.notes}
                              </span>
                            )}
                            {documentType === 'estimate' ? (
                              <>
                              {canEditLines && (
                                <div className="mt-1 space-y-1 print:hidden">
                                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={unavailable}
                                        onChange={(e) =>
                                          updateDraftLine(item.id, {
                                            unavailable: e.target.checked
                                          })
                                        }
                                        className="rounded border-slate-300 text-rose-600 focus:ring-rose-500"
                                      />
                                      <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500">
                                        {t('invoice.markUnavailable')}
                                      </span>
                                    </label>
                                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={Boolean(item.includePhotoLink)}
                                        onChange={(e) => {
                                          const on = e.target.checked;
                                          updateDraftLine(item.id, {
                                            includePhotoLink: on,
                                            ...(on ? {} : { photoUrl: null })
                                          });
                                        }}
                                        className="rounded border-slate-300 text-ink-600 focus:ring-ink-500"
                                      />
                                      <span className="text-[9px] font-bold uppercase tracking-wide text-slate-500 inline-flex items-center gap-1">
                                        <ImageIcon className="h-3 w-3" />
                                        {t('invoice.photoLink')}
                                      </span>
                                    </label>
                                  </div>
                                  {item.includePhotoLink && (
                                    <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2 space-y-2 max-w-md">
                                      {(() => {
                                        const photo = linePhotoUrl(item);
                                        return photo ? (
                                          <div className="flex items-center gap-2">
                                            <a
                                              href={photo}
                                              target="_blank"
                                              rel="noreferrer"
                                              className="shrink-0"
                                            >
                                              <img
                                                src={photo}
                                                alt=""
                                                className="h-14 w-14 rounded-lg object-cover border border-slate-200"
                                              />
                                            </a>
                                            <div className="min-w-0 flex-1">
                                              <p className="text-[10px] font-bold text-ink-800">
                                                {t('invoice.viewPhoto')}
                                              </p>
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  updateDraftLine(item.id, {
                                                    photoUrl: null
                                                  })
                                                }
                                                className="text-[10px] font-semibold text-rose-600 hover:underline"
                                              >
                                                {t('invoice.clearPhoto')}
                                              </button>
                                            </div>
                                          </div>
                                        ) : (
                                          <p className="text-[10px] text-slate-500">
                                            {t('invoice.photoPickOrUpload')}
                                          </p>
                                        );
                                      })()}
                                      <label className="block">
                                        <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400">
                                          {t('invoice.chooseInventoryPhoto')}
                                        </span>
                                        <select
                                          value={
                                            plantsWithPhotos.find(
                                              (p) => p.photoUrl === item.photoUrl
                                            )?.id || ''
                                          }
                                          onChange={(e) => {
                                            const plant = plantsWithPhotos.find(
                                              (p) => p.id === e.target.value
                                            );
                                            if (!plant?.photoUrl) return;
                                            updateDraftLine(item.id, {
                                              includePhotoLink: true,
                                              photoUrl: plant.photoUrl
                                            });
                                          }}
                                          className="mt-0.5 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-800 focus:outline-none focus:ring-1 focus:ring-ink-600"
                                        >
                                          <option value="">
                                            {plantsWithPhotos.length
                                              ? t('invoice.chooseInventoryPhotoPlaceholder')
                                              : t('invoice.noInventoryPhotos')}
                                          </option>
                                          {plantsWithPhotos.map((plant) => (
                                            <option key={plant.id} value={plant.id}>
                                              {plant.plantName}
                                              {plant.containerSize
                                                ? ` · ${plant.containerSize}`
                                                : ''}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                      <label className="inline-flex items-center gap-1.5 cursor-pointer text-[10px] font-bold text-ink-700 hover:text-ink-900">
                                        <Upload className="h-3.5 w-3.5" />
                                        {photoUploadBusyId === item.id
                                          ? t('invoice.photoUploading')
                                          : t('invoice.uploadPhoto')}
                                        <input
                                          type="file"
                                          accept="image/*"
                                          className="hidden"
                                          disabled={photoUploadBusyId === item.id}
                                          onChange={(e) => {
                                            const file = e.target.files?.[0];
                                            e.target.value = '';
                                            if (file) void handleEstimatePhotoUpload(item, file);
                                          }}
                                        />
                                      </label>
                                      {photoPickError && (
                                        <p className="text-[10px] text-rose-600">{photoPickError}</p>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                              <label className="block mt-1.5">
                                <span className="text-[9px] font-bold uppercase tracking-wide text-slate-400">
                                  {t('invoice.possibleSubs')}
                                </span>
                                <input
                                  type="text"
                                  value={subs}
                                  onChange={(e) =>
                                    setItemSubstitutes((prev) => ({
                                      ...prev,
                                      [item.id]: e.target.value
                                    }))
                                  }
                                  placeholder={t('invoice.possibleSubsPlaceholder')}
                                  className="mt-0.5 w-full max-w-md rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-normal text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-ink-600 focus:bg-white"
                                />
                              </label>
                              <label className="block mt-1.5 print:hidden">
                                <span className="text-[9px] font-bold uppercase tracking-wide text-indigo-500 inline-flex items-center gap-1">
                                  {t('invoice.quotedVendor')}
                                  <span className="normal-case tracking-normal font-semibold text-indigo-400">
                                    ({t('invoice.internalOnly')})
                                  </span>
                                </span>
                                <input
                                  type="text"
                                  list="estimate-vendor-suggestions"
                                  value={item.vendor || ''}
                                  onChange={(e) =>
                                    updateDraftLine(item.id, { vendor: e.target.value })
                                  }
                                  placeholder={t('invoice.quotedVendorPlaceholder')}
                                  className="mt-0.5 w-full max-w-md rounded-lg border border-indigo-200 bg-indigo-50/50 px-2 py-1 text-[11px] font-normal text-indigo-950 placeholder:text-indigo-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:bg-white"
                                />
                              </label>
                              </>
                            ) : subs.trim() ? (
                              <span className="block text-[10px] text-slate-500 font-normal italic mt-0.5">
                                {t('invoice.possibleSubs')}: {subs.trim()}
                              </span>
                            ) : null}
                          </td>
                          <td className={`py-1.5 text-center font-mono font-bold ${unavailable ? 'text-slate-400' : 'text-gray-500'}`}>
                            {canEditLines ? (
                              <input
                                type="text"
                                value={item.containerSize}
                                onChange={(e) =>
                                  updateDraftLine(item.id, { containerSize: e.target.value })
                                }
                                placeholder={t('invoice.potSize')}
                                className={`w-24 mx-auto text-center font-mono font-bold bg-transparent hover:bg-slate-50 border-b border-transparent focus:border-ink-600 focus:outline-none print:border-none ${
                                  unavailable ? 'text-slate-400' : 'text-gray-700'
                                }`}
                              />
                            ) : (
                              item.containerSize
                            )}
                          </td>
                          <td className={`py-1.5 text-center font-mono font-bold ${unavailable ? 'text-slate-400' : 'text-gray-900'}`}>
                            {canEditLines ? (
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={qty || ''}
                                onChange={(e) =>
                                  updateDraftLine(item.id, {
                                    quantity: Math.max(0, Number(e.target.value) || 0)
                                  })
                                }
                                className={`w-16 mx-auto text-center font-mono font-bold bg-transparent hover:bg-slate-50 border-b border-transparent focus:border-ink-600 focus:outline-none print:border-none ${
                                  unavailable ? 'text-slate-400' : 'text-gray-900'
                                }`}
                              />
                            ) : (
                              qty
                            )}
                          </td>
                          <td className="py-1.5 text-right">
                            {/* Inline editable price */}
                            <div className={`inline-flex items-center justify-end ${unavailable ? 'opacity-40' : ''}`}>
                              <span className="price-input-prefix text-[10px] text-slate-400 font-mono font-bold mr-0.5">$</span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={price}
                                onChange={(e) => handlePriceChange(item.id, Number(e.target.value))}
                                className="price-input w-20 font-mono font-bold text-right text-ink-800 focus:text-ink-950 focus:outline-none focus:ring-1 focus:ring-ink-600 bg-ink-50/40 hover:bg-ink-100/40 px-1 py-0.5 rounded transition-all focus:bg-white"
                              />
                            </div>
                          </td>
                          <td className={`py-1.5 text-right font-mono font-black ${unavailable ? 'text-slate-400' : 'text-gray-950'}`}>
                            {unavailable ? '—' : `$${total.toFixed(2)}`}
                          </td>
                          {canEditLines && (
                            <td className="py-1.5 text-right print:hidden">
                              <button
                                type="button"
                                onClick={() => removeDraftLine(item.id)}
                                disabled={workingItems.length <= 1}
                                className="p-1 text-slate-400 hover:text-rose-600 disabled:opacity-30"
                                title={t('invoice.removeLine')}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {canEditLines && (
                  <button
                    type="button"
                    onClick={addDraftLine}
                    className="mt-3 hidden md:inline-flex print:hidden items-center gap-1 text-xs font-bold text-ink-700 hover:text-ink-900"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {isCreditMemo ? t('invoice.addCreditLine') : t('invoice.addEstimateLine')}
                  </button>
                )}
                {isEstimate && (
                  <datalist id="estimate-vendor-suggestions">
                    {vendorSuggestions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                )}
              </div>

              {/* Summary and Totals Area */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-6 pt-2 pb-6 border-b border-gray-300">
                {/* Payment terms notes */}
                <div className="md:col-span-7 space-y-4">
                  <div className="text-[10px] leading-relaxed text-gray-500 font-sans">
                    <p className="font-black uppercase text-gray-400 tracking-wider mb-1">{t('invoice.customerTermsGuarantee')}</p>
                    <p className="italic">
                      {t('invoice.customerTermsText')}
                    </p>
                  </div>
                  
                  <div className="border border-gray-200 rounded-xl p-3 bg-slate-50 text-[10px] font-sans">
                    <p className="font-bold text-ink-800 uppercase tracking-wider mb-1 flex items-center">
                      <Landmark className="h-3.5 w-3.5 mr-1" /> Payment instructions:
                    </p>
                    <p className="text-gray-600 leading-normal">
                      {isPaid ? (
                        <>
                          This invoice has been <span className="font-bold text-emerald-800">paid in full</span>
                          {paymentDocument?.paidAt
                            ? ` on ${new Date(paymentDocument.paidAt).toLocaleDateString()}.`
                            : '.'}
                        </>
                      ) : (
                        <>
                          Please make check payable to <span className="font-bold text-gray-950">{nurseryName}</span> and send to mailing office, or coordinate directly with our logistics team for convenient secure ACH/wire transfer credentials.
                        </>
                      )}
                    </p>
                  </div>
                </div>

                {/* Subtotal table */}
                <div className="md:col-span-5 flex flex-col space-y-1.5 text-xs text-right font-mono">
                  
                  {/* Subtotal */}
                  <div className="flex justify-between py-1 border-b border-gray-150">
                    <span className="text-gray-500 font-medium">Subtotal:</span>
                    <span className="font-bold text-gray-950">${subtotal.toFixed(2)}</span>
                  </div>

                  {/* Freight — always editable on-screen (print shows value only) */}
                  {!isCreditMemo && (
                    <div className="flex justify-between items-center py-1 border-b border-gray-150 gap-2">
                      <span className="text-gray-500 font-medium shrink-0">Freight / Delivery:</span>
                      <div className="flex items-center justify-end min-w-0">
                        <span className="text-gray-500 mr-0.5 print:hidden">$</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={freightCharge || ''}
                          placeholder="0.00"
                          onChange={(e) => setFreightCharge(Number(e.target.value) || 0)}
                          className="price-input w-24 max-w-full font-mono font-bold text-right text-ink-800 focus:text-ink-950 focus:outline-none focus:ring-1 focus:ring-ink-600 bg-ink-50/40 hover:bg-ink-100/40 px-1 py-0.5 rounded transition-all focus:bg-white print:hidden"
                          aria-label={t('invoice.freight')}
                        />
                        <span className="hidden print:inline font-bold text-gray-950">
                          ${freightCharge.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Discount */}
                  {discount > 0 && (
                    <div className="flex justify-between py-1 border-b border-gray-150 text-rose-700">
                      <span className="font-medium text-rose-600">Discount:</span>
                      <span className="font-bold">-${discountAmount.toFixed(2)}</span>
                    </div>
                  )}

                  {/* Sales Tax */}
                  {taxRate > 0 && (
                    <div className="flex justify-between py-1 border-b border-gray-150">
                      <span className="text-gray-500 font-medium">Sales Tax ({taxRate}%):</span>
                      <span className="font-bold text-gray-950">${salesTax.toFixed(2)}</span>
                    </div>
                  )}

                  {/* Grand Total / Balance Due */}
                  {documentType === 'invoice' && isPaid && (
                    <>
                      <div className="flex justify-between py-1 border-b border-gray-150">
                        <span className="text-gray-500 font-medium">Invoice Total:</span>
                        <span className="font-bold text-gray-950">${grandTotal.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-gray-150 text-emerald-700">
                        <span className="font-medium">Amount Paid:</span>
                        <span className="font-bold">${amountPaid.toFixed(2)}</span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between py-2 border-b-4 border-double border-ink-800 bg-ink-50/35 p-1.5 rounded-lg">
                    <span className="font-sans font-black text-ink-800 text-sm uppercase tracking-wide">
                      {totalLabelUsd}
                    </span>
                    <span className="text-base font-black text-ink-950">${balanceDue.toFixed(2)}</span>
                  </div>

                </div>
              </div>

              {/* Terms and Signature */}
              <div className="pt-6 grid grid-cols-1 md:grid-cols-2 gap-8 text-[11px] font-mono leading-relaxed">
                <div>
                  <p className="text-gray-400 font-bold uppercase text-[9px] tracking-wider mb-1">
                    Customer Acknowledgment
                  </p>
                  <p className="text-[10px] text-gray-500 leading-normal mb-4 font-sans">
                    Customer representative signature acknowledges complete receipt of specified plants in acceptable condition at the agreed contract unit prices.
                  </p>
                  <div className="flex items-end pt-5 border-b border-gray-300">
                    <span className="text-[10px] text-gray-400 mr-2 shrink-0">Signed By:</span>
                    <span className="flex-1"></span>
                  </div>
                  <div className="grid grid-cols-2 gap-4 mt-2">
                    <div className="flex items-end border-b border-gray-300">
                      <span className="text-[10px] text-gray-400 mr-2 shrink-0">Print Name:</span>
                      <span className="flex-1"></span>
                    </div>
                    <div className="flex items-end border-b border-gray-300">
                      <span className="text-[10px] text-gray-400 mr-2 shrink-0">Date:</span>
                      <span className="flex-1"></span>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-50 border border-gray-250 p-4 rounded-xl font-sans">
                  <p className="text-gray-500 font-bold uppercase text-[9px] tracking-wider font-mono mb-1.5">
                    Invoice Notes / Delivery Instructions
                  </p>
                  <p className="text-xs text-gray-700 italic leading-relaxed whitespace-pre-wrap">
                    {invoiceNotes}
                  </p>
                </div>
              </div>

              {/* Page Number / Footer */}
              <div className="pt-10 text-center text-[9px] text-gray-400 font-mono">
                {nurseryName} • Thank you for your business!
              </div>

            </div>
          </div>

        </div>

      </div>

    </div>
  );
};
