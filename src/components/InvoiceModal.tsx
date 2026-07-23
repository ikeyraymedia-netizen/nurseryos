import React, { useState, useEffect, useRef } from 'react';
import {
  CustomerOrder,
  PlantOrderItem,
  InvoiceDetails,
  Customer,
  CustomerDocumentType,
  CustomerDocument,
  FreightAllocation
} from '../types';
import { 
  X, 
  Printer, 
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
  TrendingUp
} from 'lucide-react';
import { updateCustomerOrder } from '../lib/db';
import {
  addCustomerDocument,
  updateCustomerDocument,
  defaultDocumentNumber,
  listAllDocuments
} from '../lib/documents';
import { getDefaultPriceForSize } from '../lib/pricing';
import { DEFAULT_OWNERS } from '../data/owners';
import { logAuditEvent } from '../lib/audit';
import {
  allocateFreight,
  FreightAllocationMethod,
  FreightShare
} from '../lib/freightAllocation';
import { pushDocumentToQuickbooks } from '../lib/quickbooks';
import { createInvoiceCheckout } from '../lib/stripe';
import { deliverPdfBlob } from '../lib/downloadPdf';
import { PdfShareSheet } from './PdfShareSheet';
import jsPDF from 'jspdf';

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
  tenantId?: string;
  /** Enable internal cost/profit tracking (gated by the profit module). */
  canViewProfit?: boolean;
  /** Create Stripe Checkout pay links (gated by payments module). */
  canCollectPayments?: boolean;
}

export const InvoiceModal: React.FC<InvoiceModalProps> = ({
  isOpen,
  onClose,
  order,
  documentType: initialDocumentType = 'invoice',
  customer = null,
  existingDocument = null,
  truckOrders = [],
  nurseryName = 'NurseryOS',
  nurseryAddress = '',
  tenantId,
  canViewProfit = false,
  canCollectPayments = false
}) => {
  const printRef = useRef<HTMLDivElement | null>(null);
  const [documentType, setDocumentType] = useState<CustomerDocumentType>(
    existingDocument?.type || initialDocumentType
  );
  const [savedDocumentId, setSavedDocumentId] = useState<string | null>(
    existingDocument?.id || null
  );
  // State for quantity basis: 'ordered' | 'pulled' | 'loaded'
  const [qtyBasis, setQtyBasis] = useState<'ordered' | 'pulled' | 'loaded'>('ordered');

  // Customer billing details (inline editable)
  const [billToName, setBillToName] = useState(order.customerName);
  const [billToAddress, setBillToAddress] = useState('');

  // Custom invoice properties (saved in invoiceDetails)
  const [invoiceNumber, setInvoiceNumber] = useState(`INV-${order.orderNumber}`);
  const [poNumber, setPoNumber] = useState('');
  const [salesRep, setSalesRep] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().split('T')[0]);
  const [paymentTerms, setPaymentTerms] = useState('Net 30');
  const [dueDate, setDueDate] = useState('');
  const [taxRate, setTaxRate] = useState<number>(0);
  const [freightCharge, setFreightCharge] = useState<number>(0);
  const [discount, setDiscount] = useState<number>(0);
  const [invoiceNotes, setInvoiceNotes] = useState('Thank you for your business. Balance due is payable in full per the terms above.');

  // Store editable item prices
  const [itemPrices, setItemPrices] = useState<Record<string, number>>({});
  // Store editable item costs (internal profit tracking only)
  const [itemCosts, setItemCosts] = useState<Record<string, number>>({});

  // Database saving status
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showFreightAllocation, setShowFreightAllocation] = useState(false);
  const [isPushingQb, setIsPushingQb] = useState(false);
  const [qbPushMessage, setQbPushMessage] = useState<string | null>(null);
  const [isCreatingPayLink, setIsCreatingPayLink] = useState(false);
  const [payLinkMessage, setPayLinkMessage] = useState<string | null>(null);
  const [pdfSheet, setPdfSheet] = useState<{
    url: string;
    fileName: string;
    blob: Blob;
  } | null>(null);

  // Email state variables
  const [customerEmail, setCustomerEmail] = useState(order.customerEmail || '');
  const [emailSubject, setEmailSubject] = useState(`Invoice INV-${order.orderNumber}`);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailSentStatus, setEmailSentStatus] = useState<'idle' | 'success' | 'error_smtp' | 'error_general'>('idle');
  const [emailErrorMessage, setEmailErrorMessage] = useState('');
  const [showEmailPanel, setShowEmailPanel] = useState(false);

  // Initialize or reload states when order / document type changes
  useEffect(() => {
    if (!order || !isOpen) return;

    const type = existingDocument?.type || initialDocumentType;
    setDocumentType(type);
    setSavedDocumentId(existingDocument?.id || null);

    setBillToName(
      existingDocument?.billToName ||
        customer?.billingName ||
        customer?.name ||
        order.customerName
    );
    setBillToAddress(
      existingDocument?.billToAddress ||
        customer?.billingAddress ||
        customer?.shippingAddress ||
        ''
    );

    const details = order.invoiceDetails;
    const prefix = type === 'estimate' ? 'EST' : 'INV';
    setInvoiceNumber(
      existingDocument?.documentNumber ||
        details?.invoiceNumber ||
        defaultDocumentNumber(type, order.orderNumber)
    );
    setInvoiceDate(
      existingDocument?.documentDate ||
        details?.invoiceDate ||
        new Date().toISOString().split('T')[0]
    );
    setPaymentTerms(
      existingDocument?.paymentTerms ||
        details?.paymentTerms ||
        customer?.paymentTerms ||
        'Net 30'
    );
    setDueDate(existingDocument?.dueDate || details?.dueDate || '');
    setPoNumber(existingDocument?.poNumber || details?.poNumber || '');
    setSalesRep(existingDocument?.owner || order.owner || '');
    setTaxRate(
      existingDocument?.taxRate !== undefined
        ? existingDocument.taxRate
        : details?.taxRate !== undefined
          ? details.taxRate
          : 0
    );
    setFreightCharge(
      existingDocument?.freightCharge !== undefined
        ? existingDocument.freightCharge
        : details?.freightCharge !== undefined
          ? details.freightCharge
          : 0
    );
    setDiscount(
      existingDocument?.discount !== undefined
        ? existingDocument.discount
        : details?.discount !== undefined
          ? details.discount
          : 0
    );
    setInvoiceNotes(
      existingDocument?.notes ||
        details?.notes ||
        (type === 'estimate'
          ? 'This estimate is valid for 30 days. Prices subject to availability.'
          : 'Thank you for your business. Balance due is payable in full per the terms above.')
    );

    const pricesMap: Record<string, number> = {};
    if (existingDocument?.items?.length) {
      existingDocument.items.forEach((item) => {
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
    setItemPrices(pricesMap);

    const costsMap: Record<string, number> = {};
    order.items.forEach((item) => {
      costsMap[item.id] = item.unitCost ?? 0;
    });
    existingDocument?.items?.forEach((item) => {
      if (item.unitCost !== undefined) costsMap[item.id] = item.unitCost;
    });
    setItemCosts(costsMap);

    setSaveSuccess(false);

    setCustomerEmail(
      existingDocument?.customerEmail || order.customerEmail || customer?.contactEmail || ''
    );
    setEmailSubject(
      `${type === 'estimate' ? 'Estimate' : 'Invoice'} ${
        existingDocument?.documentNumber || `${prefix}-${order.orderNumber}`
      } from ${nurseryName}`
    );
    setEmailSentStatus('idle');
    setEmailErrorMessage('');
    setShowEmailPanel(false);
  }, [order, isOpen, customer, existingDocument, initialDocumentType, nurseryName]);

  // Handle default due date auto-calculation when date or terms change
  useEffect(() => {
    if (!invoiceDate) return;
    
    const baseDate = new Date(invoiceDate);
    if (isNaN(baseDate.getTime())) return;

    if (paymentTerms === 'Due on Receipt' || paymentTerms === 'COD') {
      setDueDate(invoiceDate);
    } else if (paymentTerms === 'Net 15' || paymentTerms === 'NET 15') {
      baseDate.setDate(baseDate.getDate() + 15);
      setDueDate(baseDate.toISOString().split('T')[0]);
    } else if (paymentTerms === 'Net 30' || paymentTerms === 'NET 30') {
      baseDate.setDate(baseDate.getDate() + 30);
      setDueDate(baseDate.toISOString().split('T')[0]);
    } else if (paymentTerms === 'Net 45' || paymentTerms === 'NET 45') {
      baseDate.setDate(baseDate.getDate() + 45);
      setDueDate(baseDate.toISOString().split('T')[0]);
    }
  }, [invoiceDate, paymentTerms]);

  // Synchronize email subject when document number / type changes
  useEffect(() => {
    setEmailSubject(
      `${documentType === 'estimate' ? 'Estimate' : 'Invoice'} ${invoiceNumber} from ${nurseryName}`
    );
  }, [invoiceNumber, documentType, nurseryName]);

  const docLabel = documentType === 'estimate' ? 'Estimate' : 'Invoice';
  const docLabelUpper = documentType === 'estimate' ? 'ESTIMATE' : 'INVOICE';

  // Compute Active Item Quantity based on Qty Basis
  const getItemQty = (item: PlantOrderItem): number => {
    if (qtyBasis === 'pulled') {
      return item.pulledQuantity ?? 0;
    }
    if (qtyBasis === 'loaded') {
      return item.loadedQuantity;
    }
    return item.quantity;
  };

  // Calculate Order Totals
  const subtotal = order.items.reduce((sum, item) => {
    const qty = getItemQty(item);
    const price = itemPrices[item.id] ?? 0;
    return sum + (qty * price);
  }, 0);

  const discountAmount = Math.min(subtotal, discount);
  const taxableAmount = Math.max(0, subtotal - discountAmount);
  const salesTax = Number(((taxableAmount * taxRate) / 100).toFixed(2));
  const grandTotal = subtotal - discountAmount + salesTax + freightCharge;

  // Internal cost/profit (never shown to the customer)
  const totalCost = order.items.reduce((sum, item) => {
    const qty = getItemQty(item);
    const cost = itemCosts[item.id] ?? 0;
    return sum + qty * cost;
  }, 0);
  const totalProfit = subtotal - totalCost;
  const profitMargin = subtotal > 0 ? (totalProfit / subtotal) * 100 : 0;

  // HTML Email Layout Builder
  const generateEmailHTML = (): string => {
    const itemsRows = order.items.map((item) => {
      const qty = getItemQty(item);
      const price = itemPrices[item.id] !== undefined ? itemPrices[item.id] : getDefaultPriceForSize(item.containerSize);
      const total = qty * price;
      return `
        <tr style="border-bottom: 1px solid #e2e8f0;">
          <td style="padding: 10px 0; font-weight: bold; color: #0f172a; font-family: sans-serif;">${item.plantName}</td>
          <td style="padding: 10px 0; text-align: center; color: #64748b; font-family: sans-serif;">${item.containerSize}</td>
          <td style="padding: 10px 0; text-align: center; font-weight: bold; color: #0f172a; font-family: sans-serif;">${qty}</td>
          <td style="padding: 10px 0; text-align: right; color: #047857; font-family: sans-serif;">$${price.toFixed(2)}</td>
          <td style="padding: 10px 0; text-align: right; font-weight: bold; color: #0f172a; font-family: sans-serif;">$${total.toFixed(2)}</td>
        </tr>
      `;
    }).join('');

    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; color: #1e293b; background-color: #ffffff; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
        <h1 style="color: #064e3b; margin-bottom: 2px; font-size: 24px; font-weight: 800; text-transform: uppercase; font-family: Arial, sans-serif;">${nurseryName}</h1>
        <p style="font-size: 11px; color: #047857; font-weight: bold; margin-top: 0; text-transform: uppercase; letter-spacing: 1.5px; font-family: Arial, sans-serif;">Wholesale Nursery</p>
        
        <div style="margin: 25px 0; padding: 18px; background-color: #f0fdf4; border-radius: 8px; border: 1px solid #dcfce7; font-family: Arial, sans-serif;">
          <h2 style="font-size: 18px; margin: 0 0 8px 0; color: #14532d; font-weight: 800;">${docLabel} ${invoiceNumber}</h2>
          <table style="width: 100%; font-size: 13px; font-family: Arial, sans-serif;">
            <tr>
              <td style="padding: 2px 0; color: #475569;"><strong>${docLabel} Date:</strong></td>
              <td style="padding: 2px 0; text-align: right; color: #0f172a;">${new Date(invoiceDate).toLocaleDateString(undefined, { dateStyle: 'long' })}</td>
            </tr>
            <tr>
              <td style="padding: 2px 0; color: #475569;"><strong>Terms:</strong></td>
              <td style="padding: 2px 0; text-align: right; color: #047857; font-weight: bold;">${paymentTerms}</td>
            </tr>
            <tr>
              <td style="padding: 2px 0; color: #475569;"><strong>Due Date:</strong></td>
              <td style="padding: 2px 0; text-align: right; color: #0f172a; font-weight: bold;">${dueDate ? new Date(dueDate).toLocaleDateString(undefined, { dateStyle: 'long' }) : 'Upon Receipt'}</td>
            </tr>
          </table>
        </div>

        <div style="margin-bottom: 25px; font-size: 13px; font-family: Arial, sans-serif;">
          <h3 style="color: #047857; border-bottom: 2px solid #e2e8f0; padding-bottom: 5px; margin-bottom: 10px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Bill To Customer:</h3>
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
            <tr style="border-top: 1px solid #cbd5e1;">
              <td style="padding: 10px 0 0 0; font-size: 15px; font-weight: bold; color: #064e3b; text-transform: uppercase;">${documentType === 'estimate' ? 'Estimate Total' : 'Total Due'}:</td>
              <td style="padding: 10px 0 0 0; text-align: right; font-size: 16px; font-weight: 800; color: #064e3b;">$${grandTotal.toFixed(2)}</td>
            </tr>
          </table>
        </div>

        ${invoiceNotes ? `
        <div style="margin-top: 30px; padding: 15px; background-color: #f8fafc; border-radius: 8px; font-size: 12px; color: #475569; border: 1px solid #e2e8f0; font-family: Arial, sans-serif;">
          <strong style="display: block; margin-bottom: 5px; color: #0f172a; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px;">Notes & Delivery Instructions:</strong>
          <p style="margin: 0; line-height: 1.5; white-space: pre-wrap;">${invoiceNotes}</p>
        </div>` : ''}

        <div style="margin-top: 30px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 15px; font-family: Arial, sans-serif;">
          <p style="margin: 0;">${nurseryName}</p>
          <p style="margin: 5px 0 0 0; font-weight: bold; color: #047857;">Thank you for your business!</p>
        </div>
      </div>
    `;
  };

  // Plain Text Email Builder
  const generateEmailText = (): string => {
    const itemsText = order.items.map((item) => {
      const qty = getItemQty(item);
      const price = itemPrices[item.id] !== undefined ? itemPrices[item.id] : getDefaultPriceForSize(item.containerSize);
      const total = qty * price;
      return `${item.plantName.padEnd(30)} | ${item.containerSize.padEnd(8)} | Qty: ${String(qty).padEnd(4)} | Price: $${price.toFixed(2).padEnd(6)} | Total: $${total.toFixed(2)}`;
    }).join('\n');

    return `
${nurseryName.toUpperCase()}
Wholesale Nursery

${docLabelUpper}: ${invoiceNumber}
Date: ${new Date(invoiceDate).toLocaleDateString(undefined, { dateStyle: 'long' })}
Terms: ${paymentTerms}
Due Date: ${dueDate ? new Date(dueDate).toLocaleDateString(undefined, { dateStyle: 'long' }) : 'Upon Receipt'}

BILL TO:
${billToName}
${billToAddress}

--------------------------------------------------------------------------------
PLANT ITEMS:
--------------------------------------------------------------------------------
${itemsText}
--------------------------------------------------------------------------------

Subtotal: $${subtotal.toFixed(2)}
${freightCharge > 0 ? `Freight / Shipping: $${freightCharge.toFixed(2)}\n` : ''}${discount > 0 ? `Discount: -$${discountAmount.toFixed(2)}\n` : ''}${taxRate > 0 ? `Sales Tax (${taxRate}%): $${salesTax.toFixed(2)}\n` : ''}${documentType === 'estimate' ? 'ESTIMATE TOTAL' : 'GRAND TOTAL'} (USD): $${grandTotal.toFixed(2)}

${invoiceNotes ? `NOTES:\n${invoiceNotes}\n` : ''}
Thank you for choosing ${nurseryName}!
`;
  };

  // Direct Server Email Dispatch
  const handleSendEmailServer = async () => {
    if (!customerEmail || !customerEmail.includes('@')) {
      setEmailSentStatus('error_general');
      setEmailErrorMessage('Please enter a valid customer email address.');
      return;
    }

    setIsSendingEmail(true);
    setEmailSentStatus('idle');
    setEmailErrorMessage('');

    try {
      const emailHtml = generateEmailHTML();
      const emailText = generateEmailText();

      const response = await fetch('/api/send-invoice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: customerEmail,
          subject: emailSubject,
          text: emailText,
          html: emailHtml,
        }),
      });

      let result;
      try {
        result = await response.json();
      } catch (e) {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        throw new Error('Failed to parse server response.');
      }

      if (!response.ok) {
        throw new Error(result.details || result.error || `HTTP error! status: ${response.status}`);
      }

      if (result.success) {
        // Successfully dispatched via SMTP
        // Save the updated email and the timestamp on the CustomerOrder
        const updatedOrder: CustomerOrder = {
          ...order,
          customerEmail,
          emailSentAt: new Date().toISOString(),
        };

        await updateCustomerOrder(updatedOrder);
        setEmailSentStatus('success');
      } else if (result.code === 'SMTP_NOT_CONFIGURED') {
        setEmailSentStatus('error_smtp');
        setEmailErrorMessage(result.message || 'SMTP settings are not configured on the server.');
      } else {
        setEmailSentStatus('error_general');
        setEmailErrorMessage(result.error || 'Failed to dispatch email.');
      }
    } catch (err: any) {
      console.error('Email sending error:', err);
      setEmailSentStatus('error_general');
      setEmailErrorMessage(err.message || 'An unexpected error occurred while sending the email.');
    } finally {
      setIsSendingEmail(false);
    }
  };

  // Fallback: Open Default Mail Client
  const handleOpenMailClient = () => {
    if (!customerEmail) {
      setEmailSentStatus('error_general');
      setEmailErrorMessage('Please enter a customer email address first.');
      return;
    }
    const textBody = generateEmailText();
    const mailtoUrl = `mailto:${encodeURIComponent(customerEmail)}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(textBody)}`;
    window.open(mailtoUrl, '_blank');
    
    // Save email only tracking
    const saveEmailTracking = async () => {
      try {
        const updatedOrder: CustomerOrder = {
          ...order,
          customerEmail,
          emailSentAt: new Date().toISOString() + ' (opened in mail client)',
        };
        await updateCustomerOrder(updatedOrder);
      } catch (e) {
        console.error('Error tracking email event:', e);
      }
    };
    saveEmailTracking();
  };

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
    order.items.forEach((item) => {
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

      const updatedItems = order.items.map((item) => ({
        ...item,
        unitPrice:
          itemPrices[item.id] !== undefined
            ? itemPrices[item.id]
            : getDefaultPriceForSize(item.containerSize),
        unitCost: itemCosts[item.id] !== undefined ? itemCosts[item.id] : item.unitCost
      }));

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
        owner: salesRep.trim() || order.owner || undefined
      };

      const isDocumentOnlyOrder = order.id.startsWith('preview-');
      if (!isDocumentOnlyOrder) {
        await updateCustomerOrder(updatedOrder);
      }

      const lineItems = updatedItems.map((item) => ({
        id: item.id,
        plantName: item.plantName,
        containerSize: item.containerSize,
        quantity: getItemQty(item),
        unitPrice: item.unitPrice ?? 0,
        unitCost: item.unitCost,
        notes: item.notes
      }));

      const customerId = customer?.id || order.customerId;
      if (!customerId) {
        throw new Error('No customer linked. Assign a customer on the order before saving.');
      }

      const docPayload = {
          customerId,
          customerName: billToName || customer?.name || order.customerName,
          orderId: isDocumentOnlyOrder ? undefined : order.id,
          orderNumber: order.orderNumber,
          type: documentType,
          documentNumber: invoiceNumber,
          documentDate: invoiceDate,
          dueDate: dueDate || undefined,
          poNumber: poNumber.trim() || undefined,
          paymentTerms,
          taxRate,
          freightCharge: currentFreight,
          freightAllocation,
          discount,
          notes: invoiceNotes,
          billToName,
          billToAddress: billToAddress || undefined,
          customerEmail: customerEmail || undefined,
          owner: salesRep.trim() || undefined,
          items: lineItems,
          subtotal,
          salesTax,
          grandTotal: savedGrandTotal
        };

        if (savedDocumentId) {
          await updateCustomerDocument({
            id: savedDocumentId,
            ...docPayload,
            createdAt: existingDocument?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
        } else {
          const newId = await addCustomerDocument(docPayload);
          setSavedDocumentId(newId);
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

      setSaveSuccess(true);
    } catch (err: any) {
      console.error('Failed to save document:', err);
      const code = err?.code || '';
      const message = err?.message || String(err);
      if (code === 'permission-denied' || /insufficient permissions/i.test(message)) {
        alert(
          'Could not save invoice to customer: Firestore permission denied.\n\nAsk your admin to deploy firestore.rules (documents collection), then try again.'
        );
      } else if (!customer?.id && !order.customerId) {
        alert('Could not save. Link a customer on the order, then try again.');
      } else {
        alert(`Could not save invoice to customer: ${message}`);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handlePushToQuickbooks = async () => {
    if (!tenantId) {
      alert('Nursery context missing. Close and reopen this invoice.');
      return;
    }
    if (!savedDocumentId) {
      alert(`Save this ${docLabel.toLowerCase()} to the customer first, then push to QuickBooks.`);
      return;
    }
    setIsPushingQb(true);
    setQbPushMessage(null);
    try {
      const result = await pushDocumentToQuickbooks({
        tenantId,
        documentId: savedDocumentId
      });
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
      const customerBit = result.customerName ? ` · customer “${result.customerName}”` : '';
      const totalBit =
        result.totalAmt != null ? ` · $${Number(result.totalAmt).toFixed(2)}` : '';
      const linesBit =
        result.lineCount != null ? ` · ${result.lineCount} plant line(s)` : '';
      const previewBit =
        result.linePreview && result.linePreview.length
          ? `\nPlants: ${result.linePreview.join('; ')}`
          : '';
      setQbPushMessage(`Synced to ${where}${companyBit} · ${docBit}`);
      if (result.openUrl) {
        window.open(result.openUrl, '_blank', 'noopener,noreferrer');
      }
      alert(
        `Invoice pushed to ${where}${companyBit}.\n\n` +
          `${docBit}${customerBit}${totalBit}${linesBit}${previewBit}\n\n` +
          (result.openUrl
            ? `Opening the connected sandbox company now.\nIf the tab looks wrong, use Team → Show recent QBO invoices.`
            : 'Use Team → Show recent QBO invoices to open it.')
      );
    } catch (err: any) {
      alert(err?.message || 'Failed to push to QuickBooks.');
    } finally {
      setIsPushingQb(false);
    }
  };

  const handleCreatePayLink = async () => {
    if (!tenantId) {
      alert('Nursery context missing. Close and reopen this invoice.');
      return;
    }
    if (!savedDocumentId) {
      alert(`Save this ${docLabel.toLowerCase()} to the customer first, then create a pay link.`);
      return;
    }
    if (documentType !== 'invoice') {
      alert('Only invoices can be collected via Stripe. Convert or save as an invoice first.');
      return;
    }
    setIsCreatingPayLink(true);
    setPayLinkMessage(null);
    try {
      const result = await createInvoiceCheckout({
        tenantId,
        documentId: savedDocumentId
      });
      await logAuditEvent({
        action: 'stripe.checkout_created',
        summary: `Created Stripe pay link for invoice ${invoiceNumber}`,
        meta: { documentId: savedDocumentId, sessionId: result.sessionId }
      });
      setPayLinkMessage('Pay link ready');
      window.open(result.url, '_blank', 'noopener,noreferrer');
      try {
        await navigator.clipboard.writeText(result.url);
        alert('Stripe pay link opened in a new tab and copied to your clipboard.');
      } catch {
        alert(`Stripe pay link ready:\n\n${result.url}`);
      }
    } catch (err: any) {
      alert(err?.message || 'Failed to create Stripe pay link.');
    } finally {
      setIsCreatingPayLink(false);
    }
  };

  const handleExportPdf = async () => {
    try {
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

      // Header
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(20);
      pdf.setTextColor(6, 46, 30);
      pdf.text((nurseryName || 'NurseryOS').toUpperCase(), margin, y + 6);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8);
      pdf.setTextColor(120, 120, 120);
      pdf.text('WHOLESALE NURSERY', margin, y + 20);

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(20, 120, 80);
      pdf.text(docLabelUpper, rightX, y + 2, { align: 'right' });
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(16);
      pdf.setTextColor(20, 20, 20);
      pdf.text(invoiceNumber || docLabel, rightX, y + 20, { align: 'right' });

      y += 40;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(60, 60, 60);
      const metaLines: string[] = [
        `Date: ${invoiceDate ? new Date(invoiceDate).toLocaleDateString() : '—'}`
      ];
      if (poNumber.trim()) metaLines.push(`P.O. #: ${poNumber.trim()}`);
      metaLines.push(`Terms: ${paymentTerms || '—'}`);
      metaLines.push(
        `Due: ${dueDate ? new Date(dueDate).toLocaleDateString() : 'Upon Receipt'}`
      );
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
      pdf.setTextColor(20, 120, 80);
      pdf.text('BILL TO', margin, partiesTop);
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
      pdf.setTextColor(20, 120, 80);
      pdf.text('SHIP FROM', originX, partiesTop);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(80, 80, 80);
      let rightY = partiesTop + 15;
      pdf.text(`Shipper: ${nurseryName}`, originX, rightY);
      rightY += 12;
      const originText = nurseryAddress || 'Nursery loading facility';
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
        pdf.text('PLANT VARIETY', xPlant, y);
        pdf.text('SIZE', xSize, y);
        pdf.text('QTY', xQty, y, { align: 'right' });
        pdf.text('UNIT PRICE', xPrice, y, { align: 'right' });
        pdf.text('TOTAL', xTotal, y, { align: 'right' });
        y += 6;
        pdf.line(margin, y, rightX, y);
        y += 12;
      };

      ensureSpace(40);
      drawItemsHeader();

      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      order.items.forEach((item) => {
        const qty = getItemQty(item);
        const price =
          itemPrices[item.id] !== undefined
            ? itemPrices[item.id]
            : getDefaultPriceForSize(item.containerSize);
        const total = qty * price;

        const nameLines = pdf.splitTextToSize(item.plantName || '—', xSize - xPlant - 10);
        const rowHeight = Math.max(14, nameLines.length * 11 + 3);
        if (y + rowHeight > pageHeight - margin) {
          pdf.addPage();
          y = margin;
          drawItemsHeader();
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(9);
        }

        pdf.setTextColor(20, 20, 20);
        nameLines.forEach((l: string, i: number) => {
          pdf.text(l, xPlant, y + i * 11);
        });
        pdf.setTextColor(90, 90, 90);
        pdf.text(String(item.containerSize || ''), xSize, y);
        pdf.setTextColor(20, 20, 20);
        pdf.text(String(qty), xQty, y, { align: 'right' });
        pdf.text(money(price), xPrice, y, { align: 'right' });
        pdf.setFont('helvetica', 'bold');
        pdf.text(money(total), xTotal, y, { align: 'right' });
        pdf.setFont('helvetica', 'normal');

        y += rowHeight;
        pdf.setDrawColor(230, 230, 230);
        pdf.setLineWidth(0.5);
        pdf.line(margin, y - 4, rightX, y - 4);
      });

      // Totals
      y += 10;
      ensureSpace(90);
      const labelX = margin + contentWidth - 170;
      const writeTotal = (label: string, value: string, bold = false, big = false) => {
        pdf.setFont('helvetica', bold ? 'bold' : 'normal');
        pdf.setFontSize(big ? 12 : 9);
        pdf.setTextColor(bold ? 6 : 90, bold ? 46 : 90, bold ? 30 : 90);
        pdf.text(label, labelX, y);
        pdf.setTextColor(20, 20, 20);
        pdf.text(value, xTotal, y, { align: 'right' });
        y += big ? 20 : 14;
      };

      writeTotal('Subtotal', money(subtotal));
      if (discountAmount > 0) writeTotal('Discount', `-${money(discountAmount)}`);
      if (freightCharge > 0) writeTotal('Freight / Shipping', money(freightCharge));
      if (salesTax > 0) writeTotal(`Sales Tax (${taxRate}%)`, money(salesTax));
      pdf.setDrawColor(180, 180, 180);
      pdf.setLineWidth(1);
      pdf.line(labelX, y - 4, rightX, y - 4);
      y += 8;
      writeTotal('GRAND TOTAL', money(grandTotal), true, true);

      // Notes
      if (invoiceNotes.trim()) {
        y += 10;
        ensureSpace(40);
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(8);
        pdf.setTextColor(110, 110, 110);
        pdf.text('NOTES', margin, y);
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

      // Mobile-safe delivery — never navigates the SPA away (that blanked phones).
      const fileName = `${(invoiceNumber || docLabel).replace(/[^\w.-]+/g, '_')}.pdf`;
      const result = await deliverPdfBlob(pdf.output('blob'), fileName);
      if (result.method === 'preview') {
        setPdfSheet({
          url: result.url,
          fileName: result.fileName,
          blob: result.blob
        });
      }
    } catch (err) {
      console.error('PDF export failed:', err);
      alert(`PDF export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Avoid window.print() — it can crash Cursor's embedded browser / Electron webviews.
  const handlePrint = async () => {
    await handleExportPdf();
  };

  const handleDocumentTypeChange = (type: CustomerDocumentType) => {
    setDocumentType(type);
    setInvoiceNumber(defaultDocumentNumber(type, order.orderNumber));
    setSaveSuccess(false);
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-start overflow-y-auto p-4 md:p-8 z-50 print:p-0 print:bg-white print:backdrop-blur-none">
      {pdfSheet && (
        <PdfShareSheet
          url={pdfSheet.url}
          fileName={pdfSheet.fileName}
          blob={pdfSheet.blob}
          title={`${docLabel} ready`}
          onClose={() => setPdfSheet(null)}
        />
      )}
      {showFreightAllocation && (
        <div className="fixed inset-0 z-[70] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4 print:hidden">
          <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 bg-emerald-950 text-white">
              <h3 className="text-base font-black">Distribute truck freight?</h3>
              <p className="text-xs text-emerald-200 mt-1">
                This truck has {uniqueTruckOrders.length} orders and ${freightCharge.toFixed(2)} in
                total freight.
              </p>
            </div>
            <div className="p-5 space-y-3">
              <button
                type="button"
                onClick={() => handleFreightChoice('equal')}
                className="w-full text-left rounded-xl border-2 border-slate-200 hover:border-emerald-500 hover:bg-emerald-50 px-4 py-3 transition-colors"
              >
                <span className="block text-sm font-black text-gray-900">Split evenly</span>
                <span className="block text-xs text-slate-500 mt-0.5">
                  Divide the freight equally across all {uniqueTruckOrders.length} invoices.
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleFreightChoice('truckUsage')}
                className="w-full text-left rounded-xl border-2 border-slate-200 hover:border-emerald-500 hover:bg-emerald-50 px-4 py-3 transition-colors"
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
      
      {/* Modal Container */}
      <div className="bg-white w-full max-w-5xl rounded-3xl border border-gray-150 shadow-2xl overflow-hidden flex flex-col md:flex-row print:shadow-none print:border-none print:rounded-none">
        
        {/* Left Side: Customize Form (Hidden during print) */}
        <div className="w-full md:w-80 bg-slate-50 border-r border-gray-150 p-6 flex flex-col space-y-4 shrink-0 print:hidden overflow-y-auto max-h-[90vh] md:max-h-[85vh] lg:max-h-none">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-black text-gray-900 font-sans tracking-tight uppercase flex items-center">
              <FileCheck className="h-4 w-4 mr-2 text-emerald-800" />
              {docLabel} Settings
            </h3>
            <button
              onClick={onClose}
              className="md:hidden p-1.5 rounded-lg hover:bg-gray-200 text-gray-400 hover:text-gray-900 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3.5 text-xs">
            {/* Estimate vs Invoice */}
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1.5 uppercase tracking-wider text-[10px]">
                Document Type
              </label>
              <div className="grid grid-cols-2 gap-1 bg-gray-200/60 p-1 rounded-lg">
                {(['estimate', 'invoice'] as const).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => handleDocumentTypeChange(type)}
                    className={`py-1.5 text-[10px] font-bold rounded-md capitalize transition-all ${
                      documentType === type
                        ? 'bg-emerald-700 text-white shadow-sm'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-300/40'
                    }`}
                  >
                    {type === 'estimate' ? 'Estimate' : 'Invoice'}
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
                        ? 'bg-emerald-700 text-white shadow-sm'
                        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-300/40'
                    }`}
                  >
                    {basis === 'ordered' ? 'Ordered' : basis === 'pulled' ? 'Pulled' : 'Loaded'}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-500 mt-1 italic">
                Invoicing based on {qtyBasis === 'ordered' ? 'original customer order counts' : qtyBasis === 'pulled' ? 'items delivered/pulled from nursery' : 'items loaded onto the truck'}.
              </p>
            </div>

            {/* Invoice Number */}
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {docLabel} Number
              </label>
              <input
                type="text"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-semibold text-gray-800"
              />
            </div>

            {/* Customer PO Number */}
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Customer P.O. #
              </label>
              <input
                type="text"
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
                placeholder="Customer purchase order number"
                className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-semibold text-gray-800"
              />
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                Prints on the invoice & BOL, and syncs to the QuickBooks P.O. field.
              </p>
            </div>

            {/* Sales Rep (profit attribution) */}
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Sales Rep
              </label>
              <select
                value={salesRep}
                onChange={(e) => setSalesRep(e.target.value)}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-semibold text-gray-800"
              >
                <option value="">Unassigned</option>
                {DEFAULT_OWNERS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {salesRep && !DEFAULT_OWNERS.includes(salesRep) && (
                  <option value={salesRep}>{salesRep}</option>
                )}
              </select>
              <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                Credits this invoice&apos;s profit to the rep in Reports.
              </p>
            </div>

            {/* Date and Terms */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                  Invoice Date
                </label>
                <input
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
                />
              </div>
              <div>
                <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                  Terms
                </label>
                <select
                  value={paymentTerms}
                  onChange={(e) => setPaymentTerms(e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
                >
                  <option value="Due on Receipt">Due on Receipt</option>
                  <option value="COD">COD (Pickup)</option>
                  <option value="Net 15">Net 15</option>
                  <option value="Net 30">Net 30</option>
                  <option value="Net 45">Net 45</option>
                </select>
              </div>
            </div>

            {/* Due Date */}
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Due Date
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
              />
            </div>

            {/* Financial Adjustments */}
            <div className="bg-slate-100 p-2.5 rounded-xl space-y-2 border border-slate-200">
              <span className="block font-mono font-bold text-[9px] text-gray-400 uppercase tracking-widest">Charges & Adjustments</span>
              
              {/* Freight Charge */}
              <div>
                <label className="flex items-center justify-between font-bold text-gray-600 mb-0.5">
                  <span>Freight / Shipping ($)</span>
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
                    className="w-full pl-7 pr-3 py-1 border border-gray-200 rounded-lg focus:outline-none focus:border-emerald-500 bg-white font-mono font-medium"
                  />
                </div>
              </div>

              {/* Tax Rate */}
              <div>
                <label className="flex items-center justify-between font-bold text-gray-600 mb-0.5">
                  <span>Tax Rate (%)</span>
                  <button 
                    onClick={() => setTaxRate(taxRate === 0 ? 4.45 : 0)}
                    className="text-[9px] text-emerald-700 hover:underline"
                  >
                    {taxRate === 0 ? 'Use 4.45%' : 'Exempt (0%)'}
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
                    className="w-full pl-7 pr-3 py-1 border border-gray-200 rounded-lg focus:outline-none focus:border-emerald-500 bg-white font-mono font-medium"
                  />
                </div>
              </div>

              {/* Discount */}
              <div>
                <label className="flex items-center justify-between font-bold text-gray-600 mb-0.5">
                  <span>Flat Discount ($)</span>
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
                    className="w-full pl-7 pr-3 py-1 border border-gray-200 rounded-lg focus:outline-none focus:border-emerald-500 bg-white font-mono font-medium"
                  />
                </div>
              </div>
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
                className="w-full px-2.5 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white text-[11px] leading-relaxed"
              />
            </div>

            {/* Quick Actions */}
            <div className="pt-2">
              <button
                type="button"
                onClick={handleResetPrices}
                className="text-emerald-700 hover:text-emerald-950 font-bold flex items-center gap-1 hover:underline text-[10px]"
              >
                <RefreshCw className="h-3 w-3" />
                <span>Reset to Standard Wholesale Prices</span>
              </button>
            </div>

            {/* Internal Cost & Profit (never printed or emailed to the customer) */}
            {canViewProfit && (
              <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="font-black uppercase tracking-wider text-[10px] text-indigo-800 flex items-center gap-1">
                    <TrendingUp className="h-3.5 w-3.5" /> Cost & Profit
                  </p>
                  <span className="text-[8px] font-bold uppercase text-indigo-400 tracking-wide">
                    Internal only
                  </span>
                </div>
                <div className="space-y-1.5">
                  {order.items.map((item) => {
                    const qty = getItemQty(item);
                    const price =
                      itemPrices[item.id] !== undefined
                        ? itemPrices[item.id]
                        : getDefaultPriceForSize(item.containerSize);
                    const cost = itemCosts[item.id] ?? 0;
                    const lineProfit = (price - cost) * qty;
                    return (
                      <div key={item.id} className="flex items-center gap-1.5 text-[10px]">
                        <span className="flex-1 truncate font-semibold text-gray-700" title={item.plantName}>
                          {item.plantName}
                        </span>
                        <div className="inline-flex items-center">
                          <span className="text-[9px] text-slate-400 font-mono font-bold mr-0.5">$</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={cost || ''}
                            placeholder="cost"
                            onChange={(e) => handleCostChange(item.id, Number(e.target.value))}
                            className="w-14 font-mono font-bold text-right text-indigo-800 bg-white border border-indigo-200 focus:border-indigo-500 focus:outline-none px-1 py-0.5 rounded"
                          />
                        </div>
                        <span
                          className={`w-16 text-right font-mono font-bold ${
                            lineProfit >= 0 ? 'text-emerald-700' : 'text-rose-600'
                          }`}
                        >
                          ${lineProfit.toFixed(2)}
                        </span>
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
                        totalProfit >= 0 ? 'text-emerald-700' : 'text-rose-600'
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
          </div>

          <div className="pt-3 border-t border-gray-200 flex flex-col space-y-2">
            <button
              onClick={handleSaveInvoice}
              disabled={isSaving}
              className={`w-full py-2.5 px-4 rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2 ${
                saveSuccess
                  ? 'bg-teal-600 text-white'
                  : 'bg-slate-800 hover:bg-slate-900 text-white'
              }`}
            >
              {saveSuccess ? (
                <>
                  <Check className="h-4 w-4" />
                  <span>Saved to Customer!</span>
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  <span>
                    {isSaving
                      ? 'Saving...'
                      : customer?.id || order.customerId
                        ? `Save ${docLabel} to Customer`
                        : 'Save Pricing to Order'}
                  </span>
                </>
              )}
            </button>

            {tenantId && (
              <button
                type="button"
                onClick={() => void handlePushToQuickbooks()}
                disabled={isPushingQb || !savedDocumentId}
                className="w-full py-2.5 px-4 bg-sky-700 hover:bg-sky-800 disabled:opacity-50 text-white rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2"
                title={
                  savedDocumentId
                    ? 'Push saved document to QuickBooks Online'
                    : 'Save to customer first'
                }
              >
                <Link2 className="h-4 w-4" />
                <span>
                  {isPushingQb
                    ? 'Pushing to QuickBooks…'
                    : qbPushMessage ||
                      existingDocument?.qboInvoiceId ||
                      'Push to QuickBooks'}
                </span>
              </button>
            )}

            {tenantId && canCollectPayments && documentType === 'invoice' && (
              <button
                type="button"
                onClick={() => void handleCreatePayLink()}
                disabled={isCreatingPayLink || !savedDocumentId}
                className="w-full py-2.5 px-4 bg-violet-700 hover:bg-violet-800 disabled:opacity-50 text-white rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2"
                title={
                  savedDocumentId
                    ? 'Create a Stripe Checkout pay link for this invoice'
                    : 'Save to customer first'
                }
              >
                <DollarSign className="h-4 w-4" />
                <span>
                  {isCreatingPayLink
                    ? 'Creating pay link…'
                    : payLinkMessage || 'Create Stripe pay link'}
                </span>
              </button>
            )}

            <button
              onClick={handleExportPdf}
              className="w-full py-2.5 px-4 bg-white hover:bg-slate-50 text-slate-800 border border-slate-200 rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2"
            >
              <Download className="h-4 w-4" />
              <span>Export PDF</span>
            </button>

            <button
              onClick={handlePrint}
              className="w-full py-2.5 px-4 bg-emerald-800 hover:bg-emerald-900 text-white rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2"
            >
              <Printer className="h-4 w-4" />
              <span>Download & Print {docLabel}</span>
            </button>

            {/* Email Invoice Panel */}
            <div className="border-t border-gray-200 pt-3">
              <button
                type="button"
                onClick={() => setShowEmailPanel(!showEmailPanel)}
                className={`w-full py-2.5 px-4 rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2 border ${
                  showEmailPanel
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    : 'bg-white border-gray-200 hover:bg-slate-50 text-gray-700'
                }`}
              >
                <Mail className="h-4 w-4" />
                <span>{showEmailPanel ? 'Hide Email Options' : `Email ${docLabel} to Customer`}</span>
              </button>

              {showEmailPanel && (
                <div className="mt-3 p-3 bg-emerald-50/45 border border-emerald-100 rounded-2xl space-y-3.5 text-xs">
                  <div>
                    <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                      Customer Email
                    </label>
                    <input
                      type="email"
                      value={customerEmail}
                      onChange={(e) => setCustomerEmail(e.target.value)}
                      placeholder="e.g. buyer@wholesale.com"
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-semibold text-gray-800 text-xs"
                    />
                  </div>

                  <div>
                    <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                      Email Subject
                    </label>
                    <input
                      type="text"
                      value={emailSubject}
                      onChange={(e) => setEmailSubject(e.target.value)}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-semibold text-gray-800 text-xs"
                    />
                  </div>

                  {order.emailSentAt && (
                    <div className="bg-emerald-100/40 p-2.5 rounded-xl text-[10px] text-emerald-800 font-medium flex items-center space-x-1.5 border border-emerald-200/30">
                      <Check className="h-3.5 w-3.5 shrink-0" />
                      <span>Last sent: {new Date(order.emailSentAt.split(' (')[0]).toLocaleDateString()} {new Date(order.emailSentAt.split(' (')[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  )}

                  {emailSentStatus === 'success' && (
                    <div className="p-3 bg-teal-50 border border-teal-200 text-teal-800 rounded-xl text-[10px] leading-normal font-medium">
                      <p className="font-bold flex items-center mb-0.5 text-teal-900"><Check className="h-3.5 w-3.5 mr-1 text-teal-700" /> {docLabel} Sent Successfully!</p>
                      <p className="text-[9px] text-teal-700">The customer was emailed a formatted HTML version of this {docLabel.toLowerCase()}.</p>
                    </div>
                  )}

                  {emailSentStatus === 'error_smtp' && (
                    <div className="p-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl text-[10px] leading-normal">
                      <p className="font-bold flex items-center mb-1 text-amber-900"><AlertTriangle className="h-3.5 w-3.5 mr-1 text-amber-600" /> Server SMTP Not Configured</p>
                      <p className="text-[9px] text-amber-700 mb-2 leading-relaxed">
                        To send directly from the server, configure SMTP variables (<code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code>) in your secrets manager.
                      </p>
                      <button
                        onClick={handleOpenMailClient}
                        className="w-full py-1.5 bg-amber-700 hover:bg-amber-800 text-white rounded-lg text-[9px] font-black transition-all flex items-center justify-center space-x-1"
                      >
                        <Mail className="h-3 w-3" />
                        <span>Open in Default Mail Client (Mailto)</span>
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
                        <span>Fallback: Open in Mail Client</span>
                      </button>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      onClick={handleSendEmailServer}
                      disabled={isSendingEmail}
                      className="py-2 px-2.5 bg-emerald-800 hover:bg-emerald-900 text-white rounded-xl text-[10px] font-black shadow-sm transition-all flex items-center justify-center space-x-1"
                    >
                      <Send className="h-3 w-3" />
                      <span>{isSendingEmail ? 'Sending...' : 'Send Direct'}</span>
                    </button>

                    <button
                      onClick={handleOpenMailClient}
                      className="py-2 px-2.5 bg-white border border-gray-200 hover:bg-slate-100 text-gray-700 rounded-xl text-[10px] font-black shadow-sm transition-all flex items-center justify-center space-x-1"
                    >
                      <Mail className="h-3 w-3" />
                      <span>Use Mail App</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
            
            <button
              onClick={onClose}
              className="w-full py-2 bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 rounded-xl text-xs font-bold transition-all flex items-center justify-center"
            >
              Close Window
            </button>
          </div>
        </div>

        {/* Right Side / Document Preview (Becomes full-page on print) */}
        <div className="flex-1 bg-white p-6 md:p-10 flex flex-col min-h-0 print:p-0">
          
          {/* Action header inside modal (Hidden during print) */}
          <div className="flex justify-between items-center pb-4 mb-6 border-b border-gray-150 print:hidden">
            <div>
              <h2 className="text-base font-black text-gray-900 flex items-center">
                <FileCheck className="h-5 w-5 mr-1.5 text-emerald-700" />
                Invoice Preview
              </h2>
              <p className="text-[10px] text-gray-500 mt-0.5 font-sans">
                Real-time generated invoice for <span className="font-bold">{order.customerName}</span>. Type prices directly into the invoice sheet below to customize!
              </p>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={handlePrint}
                className="p-2 bg-emerald-50 border border-emerald-100 rounded-xl text-emerald-800 hover:bg-emerald-100 transition-colors"
                title="Download PDF to print"
              >
                <Printer className="h-4 w-4" />
              </button>
              <button
                onClick={onClose}
                className="p-2 hover:bg-gray-100 border border-gray-200 rounded-xl text-gray-500 hover:text-gray-900 transition-colors"
                title="Close Window"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Printable Document Sheet */}
          <div className="flex-1 overflow-y-auto pr-2 print:overflow-visible print:pr-0">
            <div
              ref={printRef}
              className="border border-gray-300 p-8 rounded-lg bg-white shadow-inner max-w-4xl mx-auto print:border-none print:shadow-none print:p-0 text-gray-900 font-sans leading-normal"
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pb-6 border-b border-gray-300">
                <div>
                  <h1 className="text-2xl font-black tracking-tight text-emerald-950 uppercase leading-none">
                    {nurseryName}
                  </h1>
                  <p className="text-xs text-gray-500 font-mono font-bold mt-1 uppercase tracking-widest">
                    Wholesale Nursery
                  </p>
                </div>
                
                <div className="sm:text-right flex flex-col justify-between items-start sm:items-end">
                  <div className="border-2 border-emerald-900/10 rounded-xl p-3 px-4 bg-emerald-50/20 inline-block text-left sm:text-right">
                    <span className="block text-[10px] font-black text-emerald-800 font-mono uppercase tracking-widest mb-0.5">
                      {docLabelUpper}
                    </span>
                    <span className="text-xl font-mono font-black text-gray-950 block">
                      {invoiceNumber}
                    </span>
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
                    <p className="text-gray-800">
                      <span className="font-bold text-gray-500">Terms:</span> <span className="font-bold text-emerald-800">{paymentTerms}</span>
                    </p>
                    <p className="text-gray-800">
                      <span className="font-bold text-gray-500">Due Date:</span> <span className="font-bold">{dueDate ? new Date(dueDate).toLocaleDateString(undefined, { dateStyle: 'long' }) : 'Upon Receipt'}</span>
                    </p>
                  </div>
                </div>
              </div>

              {/* Bill To & Ship To section */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-6 border-b border-gray-300">
                <div>
                  <h3 className="text-xs font-black font-mono uppercase text-emerald-800 tracking-wider mb-2">
                    Bill To Customer:
                  </h3>
                  <div className="text-xs text-gray-800 space-y-1">
                    {/* Inline Editable Customer Name */}
                    <input
                      type="text"
                      value={billToName}
                      onChange={(e) => setBillToName(e.target.value)}
                      className="font-bold text-sm text-gray-950 bg-transparent hover:bg-slate-50 border-b border-transparent focus:border-emerald-600 focus:bg-white focus:outline-none w-full p-0.5 rounded transition-all print:border-none print:p-0 print:font-black"
                      placeholder="Customer Name"
                    />
                    <textarea
                      rows={2}
                      value={billToAddress}
                      onChange={(e) => setBillToAddress(e.target.value)}
                      className="w-full text-xs text-gray-600 bg-transparent hover:bg-slate-50 border border-transparent focus:border-emerald-600 focus:bg-white focus:outline-none p-0.5 rounded leading-normal resize-none font-sans font-medium mt-1 print:border-none print:p-0"
                      placeholder="Billing Address"
                    />
                  </div>
                </div>
                
                <div>
                  <h3 className="text-xs font-black font-mono uppercase text-emerald-800 tracking-wider mb-2">
                    Shipping Origin & Carrier:
                  </h3>
                  <div className="text-xs text-gray-800 space-y-1 font-mono">
                    <p><span className="font-bold text-gray-400">Shipper:</span> {nurseryName}</p>
                    <p className="whitespace-pre-line">
                      <span className="font-bold text-gray-400">Origin:</span>{' '}
                      {nurseryAddress || 'Nursery loading facility'}
                    </p>
                    <p>
                      <span className="font-bold text-gray-400">Cargo Basis:</span>{' '}
                      <span className="font-bold text-emerald-900 uppercase">
                        {qtyBasis === 'ordered' ? 'Ordered Quantities' : qtyBasis === 'pulled' ? 'Delivered/Pulled Counts' : 'Loaded Counts'}
                      </span>
                    </p>
                  </div>
                </div>
              </div>

              {/* Items Table */}
              <div className="py-6">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b-2 border-gray-300 text-gray-500 text-[9px] font-black font-mono uppercase tracking-widest">
                      <th className="pb-2 text-left">Plant Variety Name</th>
                      <th className="pb-2 text-center w-28">Pot Size</th>
                      <th className="pb-2 text-center w-20">Quantity</th>
                      <th className="pb-2 text-right w-28">Unit Price</th>
                      <th className="pb-2 text-right w-24">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.items.map((item) => {
                      const qty = getItemQty(item);
                      const price = itemPrices[item.id] !== undefined ? itemPrices[item.id] : getDefaultPriceForSize(item.containerSize);
                      const total = qty * price;

                      return (
                        <tr
                          key={item.id}
                          className="border-b border-gray-200 text-xs font-medium text-gray-800"
                        >
                          <td className="py-3">
                            <span className="font-black text-gray-950">{item.plantName}</span>
                            {item.notes && (
                              <span className="block text-[10px] text-gray-400 font-normal italic mt-0.5">
                                Note: {item.notes}
                              </span>
                            )}
                          </td>
                          <td className="py-3 text-center font-mono font-bold text-gray-500">
                            {item.containerSize}
                          </td>
                          <td className="py-3 text-center font-mono font-bold text-gray-900">
                            {qty}
                          </td>
                          <td className="py-3 text-right">
                            {/* Inline editable price */}
                            <div className="inline-flex items-center justify-end">
                              <span className="price-input-prefix text-[10px] text-slate-400 font-mono font-bold mr-0.5">$</span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={price}
                                onChange={(e) => handlePriceChange(item.id, Number(e.target.value))}
                                className="price-input w-20 font-mono font-bold text-right text-emerald-800 focus:text-emerald-950 focus:outline-none focus:ring-1 focus:ring-emerald-600 bg-emerald-50/40 hover:bg-emerald-100/40 px-1 py-0.5 rounded transition-all focus:bg-white"
                              />
                            </div>
                          </td>
                          <td className="py-3 text-right font-mono font-black text-gray-950">
                            ${total.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Summary and Totals Area */}
              <div className="grid grid-cols-1 md:grid-cols-12 gap-6 pt-2 pb-6 border-b border-gray-300">
                {/* Payment terms notes */}
                <div className="md:col-span-7 space-y-4">
                  <div className="text-[10px] leading-relaxed text-gray-500 font-sans">
                    <p className="font-black uppercase text-gray-400 tracking-wider mb-1">Customer Terms & Guarantee:</p>
                    <p className="italic">
                      "All plant materials are guaranteed to be robust, healthy, and up to nursery grade standards upon delivery. Any claims or discrepancies on quantity or grade must be filed in writing with our office within 48 hours of shipment receipt. Returns are not accepted unless authorized in writing."
                    </p>
                  </div>
                  
                  <div className="border border-gray-200 rounded-xl p-3 bg-slate-50 text-[10px] font-sans">
                    <p className="font-bold text-emerald-800 uppercase tracking-wider mb-1 flex items-center">
                      <Landmark className="h-3.5 w-3.5 mr-1" /> Payment instructions:
                    </p>
                    <p className="text-gray-600 leading-normal">
                      Please make check payable to <span className="font-bold text-gray-950">{nurseryName}</span> and send to mailing office, or coordinate directly with our logistics team for convenient secure ACH/wire transfer credentials.
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

                  {/* Freight */}
                  {freightCharge > 0 && (
                    <div className="flex justify-between py-1 border-b border-gray-150">
                      <span className="text-gray-500 font-medium">Freight / Delivery:</span>
                      <span className="font-bold text-gray-950">${freightCharge.toFixed(2)}</span>
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

                  {/* Grand Total */}
                  <div className="flex justify-between py-2 border-b-4 border-double border-emerald-800 bg-emerald-50/35 p-1.5 rounded-lg">
                    <span className="font-sans font-black text-emerald-800 text-sm uppercase tracking-wide">Total Due (USD):</span>
                    <span className="text-base font-black text-emerald-950">${grandTotal.toFixed(2)}</span>
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
