import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Truck, CustomerOrder, ContainerWeight, Customer, TruckBolDraft } from '../types';
import { X, Printer, Truck as TruckIcon, User, Calendar, FileText, CheckCircle, Ship, MapPin, EyeOff, Save } from 'lucide-react';
import jsPDF from 'jspdf';
import { deliverPdfBlob } from '../lib/downloadPdf';
import { PdfShareSheet } from './PdfShareSheet';
import { useT, useLocale } from '../lib/i18n';
import { imageSrcToDataUrl, resolveNurseryLogoSrc } from '../lib/nurseryBranding';
import { sortOrdersByDropSequence } from '../lib/loadSequence';
import { orderRefLabel } from '../lib/orderLabels';

interface BillOfLadingModalProps {
  isOpen: boolean;
  onClose: () => void;
  truck: Truck;
  orders: CustomerOrder[];
  containerWeights: ContainerWeight[];
  customers?: Customer[];
  nurseryName?: string;
  /** Ship-from / origin address for the nursery. */
  nurseryAddress?: string;
  /** Nursery logo image URL (resolved from tenant branding). */
  nurseryLogoSrc?: string | null;
  /** Persist BOL form fields onto the truck so addresses survive closing. */
  onSaveBolDraft?: (draft: TruckBolDraft) => Promise<void>;
}

function defaultShipperAddress(nurseryName: string, nurseryAddress: string, fallback: string) {
  return nurseryAddress
    ? `${nurseryName}\n${nurseryAddress}`
    : `${nurseryName}\n${fallback}`;
}

export const BillOfLadingModal: React.FC<BillOfLadingModalProps> = ({
  isOpen,
  onClose,
  truck,
  orders = [],
  customers = [],
  nurseryName = 'NurseryOS',
  nurseryAddress = '',
  nurseryLogoSrc = null,
  onSaveBolDraft
}) => {
  const t = useT();
  const { locale } = useLocale();
  const logoSrc = nurseryLogoSrc || resolveNurseryLogoSrc(nurseryName);
  const truckName = String(truck?.name || t('bol.defaultTruckName'));
  const safeOrders = Array.isArray(orders) ? orders : [];

  // Delivery / drop sequence: last loaded is Stop 1
  const sortedOrders = sortOrdersByDropSequence(safeOrders, truck);

  // State for document selection: 'consolidated' or a specific customer order ID
  const [selectedBOLType, setSelectedBOLType] = useState<'consolidated' | string>('consolidated');
  /** Hide consignee / customer name on printed BOL — address only (drop-ships). */
  const [blindBol, setBlindBol] = useState(false);

  // State for customizable document fields
  const [shipperAddress, setShipperAddress] = useState(
    defaultShipperAddress(nurseryName, nurseryAddress, t('bol.defaultShipperSuffix'))
  );
  const [shipDate, setShipDate] = useState(
    truck?.loadingDate || new Date().toISOString().split('T')[0]
  );
  const [driverName, setDriverName] = useState('');
  const [truckNumber, setTruckNumber] = useState(() => {
    const match = truckName.match(/\d+/);
    return match ? t('bol.truckUnit', { num: match[0] }) : t('bol.defaultTruck');
  });
  const [trailerNumber, setTrailerNumber] = useState('');
  const [sealNumber, setSealNumber] = useState('');
  const [receiverAddress, setReceiverAddress] = useState('');
  const [receiverContact, setReceiverContact] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [specialInstructions, setSpecialInstructions] = useState(
    truck?.notes || t('bol.defaultInstructions')
  );
  const [receiverAddressesByType, setReceiverAddressesByType] = useState<Record<string, string>>(
    {}
  );
  const [receiverContactsByType, setReceiverContactsByType] = useState<Record<string, string>>(
    {}
  );
  const [poNumbersByType, setPoNumbersByType] = useState<Record<string, string>>({});
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [saveDraftSuccess, setSaveDraftSuccess] = useState(false);
  const [saveDraftError, setSaveDraftError] = useState<string | null>(null);
  const [pdfSheet, setPdfSheet] = useState<{
    url: string;
    fileName: string;
    blob: Blob;
  } | null>(null);
  const hydratedTruckIdRef = useRef<string | null>(null);
  const selectedBOLTypeRef = useRef(selectedBOLType);
  selectedBOLTypeRef.current = selectedBOLType;

  function customerForOrder(order: CustomerOrder) {
    const byId = order.customerId
      ? customers.find((c) => c.id === order.customerId)
      : undefined;
    const byName = customers.find(
      (c) => c.name.trim().toLowerCase() === order.customerName.trim().toLowerCase()
    );
    return byId || byName;
  }

  function resolveOrderReceiverName(order: CustomerOrder): string {
    const customer = customerForOrder(order);
    return customer?.shippingName?.trim() || order.customerName;
  }

  function resolveOrderDeliveryAddress(order: CustomerOrder): string {
    const customer = customerForOrder(order);
    return (
      customer?.shippingAddress?.trim() ||
      customer?.receiverAddress?.trim() ||
      ''
    );
  }

  /** Per-stop address only — never reuse another drop's form value. */
  function stopDeliveryAddress(order: CustomerOrder): string {
    const live =
      selectedBOLType === order.id
        ? receiverAddress
        : receiverAddressesByType[order.id];
    if (live !== undefined && String(live).trim()) return String(live).trim();
    return resolveOrderDeliveryAddress(order);
  }

  function resolveOrderContact(order: CustomerOrder): string {
    const customer = customerForOrder(order);
    return customer?.pointOfContact?.trim() || customer?.phone?.trim() || '';
  }

  /** Per-stop contact only — never reuse another drop's form value. */
  function stopContact(order: CustomerOrder): string {
    const live =
      selectedBOLType === order.id
        ? receiverContact
        : receiverContactsByType[order.id];
    if (live !== undefined && String(live).trim()) return String(live).trim();
    return resolveOrderContact(order);
  }

  function defaultReceiverForType(type: string): string {
    const scoped =
      type === 'consolidated'
        ? sortedOrders
        : sortedOrders.filter((o) => o.id === type);
    return Array.from(
      new Set(scoped.map((o) => resolveOrderDeliveryAddress(o)).filter(Boolean))
    ).join('\n\n');
  }

  function defaultContactForType(type: string): string {
    const scoped =
      type === 'consolidated'
        ? sortedOrders
        : sortedOrders.filter((o) => o.id === type);
    return Array.from(
      new Set(scoped.map((o) => resolveOrderContact(o)).filter(Boolean))
    ).join(', ');
  }

  function defaultPoForType(type: string): string {
    const scoped =
      type === 'consolidated'
        ? sortedOrders
        : sortedOrders.filter((o) => o.id === type);
    return Array.from(
      new Set(
        scoped
          .map((o) => (o.invoiceDetails?.poNumber || '').trim())
          .filter(Boolean)
      )
    ).join(', ');
  }

  // Hydrate from saved truck.bolDraft when the modal opens (or truck changes).
  useEffect(() => {
    if (!isOpen) {
      hydratedTruckIdRef.current = null;
      return;
    }
    if (hydratedTruckIdRef.current === truck.id) return;
    hydratedTruckIdRef.current = truck.id;

    const draft = truck.bolDraft;
    const match = truckName.match(/\d+/);
    const defaultTruckNum = match
      ? t('bol.truckUnit', { num: match[0] })
      : t('bol.defaultTruck');

    const nextType =
      draft?.selectedBOLType &&
      (draft.selectedBOLType === 'consolidated' ||
        sortedOrders.some((o) => o.id === draft.selectedBOLType))
        ? draft.selectedBOLType
        : 'consolidated';

    setSelectedBOLType(nextType);
    setBlindBol(Boolean(draft?.blindBol));
    setShipperAddress(
      draft?.shipperAddress?.trim() ||
        defaultShipperAddress(nurseryName, nurseryAddress, t('bol.defaultShipperSuffix'))
    );
    setShipDate(
      draft?.shipDate || truck.loadingDate || new Date().toISOString().split('T')[0]
    );
    setDriverName(draft?.driverName || '');
    setTruckNumber(draft?.truckNumber || defaultTruckNum);
    setTrailerNumber(draft?.trailerNumber || '');
    setSealNumber(draft?.sealNumber || '');
    setSpecialInstructions(
      draft?.specialInstructions || truck.notes || t('bol.defaultInstructions')
    );

    const savedReceivers = { ...(draft?.receiverAddresses || {}) };
    const savedContacts = { ...(draft?.receiverContacts || {}) };
    // Migrate older drafts that only stored a single shared contact.
    if (!draft?.receiverContacts && draft?.receiverContact?.trim()) {
      savedContacts[nextType] = draft.receiverContact.trim();
    }
    const savedPos = { ...(draft?.poNumbers || {}) };
    setReceiverAddressesByType(savedReceivers);
    setReceiverContactsByType(savedContacts);
    setPoNumbersByType(savedPos);
    setReceiverAddress(
      (savedReceivers[nextType] ?? '').trim() || defaultReceiverForType(nextType)
    );
    setReceiverContact(
      (savedContacts[nextType] ?? '').trim() || defaultContactForType(nextType)
    );
    setPoNumber((savedPos[nextType] ?? '').trim() || defaultPoForType(nextType));
    setSaveDraftSuccess(false);
    setSaveDraftError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, truck.id]);

  // Lock body scroll while open (helps mobile Safari keep the overlay visible).
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  function handleBolTypeChange(nextType: string) {
    const prevType = selectedBOLTypeRef.current;
    const nextReceivers = {
      ...receiverAddressesByType,
      [prevType]: receiverAddress
    };
    const nextContacts = {
      ...receiverContactsByType,
      [prevType]: receiverContact
    };
    const nextPos = {
      ...poNumbersByType,
      [prevType]: poNumber
    };
    setReceiverAddressesByType(nextReceivers);
    setReceiverContactsByType(nextContacts);
    setPoNumbersByType(nextPos);
    setSelectedBOLType(nextType);
    setReceiverAddress(
      nextReceivers[nextType] !== undefined
        ? nextReceivers[nextType]
        : defaultReceiverForType(nextType)
    );
    setReceiverContact(
      nextContacts[nextType] !== undefined
        ? nextContacts[nextType]
        : defaultContactForType(nextType)
    );
    setPoNumber(
      nextPos[nextType] !== undefined ? nextPos[nextType] : defaultPoForType(nextType)
    );
    setSaveDraftSuccess(false);
  }

  async function handleSaveBolDraft() {
    if (!onSaveBolDraft) return;
    setIsSavingDraft(true);
    setSaveDraftError(null);
    setSaveDraftSuccess(false);
    try {
      const receiverAddresses = {
        ...receiverAddressesByType,
        [selectedBOLType]: receiverAddress
      };
      const receiverContacts = {
        ...receiverContactsByType,
        [selectedBOLType]: receiverContact
      };
      const poNumbers = {
        ...poNumbersByType,
        [selectedBOLType]: poNumber
      };
      setReceiverAddressesByType(receiverAddresses);
      setReceiverContactsByType(receiverContacts);
      setPoNumbersByType(poNumbers);

      const draft: TruckBolDraft = {
        shipperAddress: shipperAddress.trim() || undefined,
        shipDate: shipDate || undefined,
        driverName: driverName.trim() || undefined,
        truckNumber: truckNumber.trim() || undefined,
        trailerNumber: trailerNumber.trim() || undefined,
        sealNumber: sealNumber.trim() || undefined,
        specialInstructions: specialInstructions.trim() || undefined,
        blindBol,
        selectedBOLType,
        receiverAddresses,
        receiverContacts,
        poNumbers,
        updatedAt: new Date().toISOString()
      };
      await onSaveBolDraft(draft);
      setSaveDraftSuccess(true);
    } catch (err: unknown) {
      setSaveDraftError(
        err instanceof Error ? err.message : t('bol.saveDraftFailed')
      );
    } finally {
      setIsSavingDraft(false);
    }
  }

  if (!isOpen) return null;

  // Filter orders based on the BOL selection type
  const currentBOLOrders = selectedBOLType === 'consolidated'
    ? sortedOrders
    : sortedOrders.filter((o) => o.id === selectedBOLType);

  const isIndividual = selectedBOLType !== 'consolidated';
  const singleOrder = isIndividual ? sortedOrders.find((o) => o.id === selectedBOLType) : null;

  // Compute Cargo Totals dynamically for the active scope of the BOL (Consolidated vs Individual)
  let totalPlants = 0;

  currentBOLOrders.forEach((order) => {
    (order.items || []).forEach((item) => {
      totalPlants += item.quantity || 0;
    });
  });

  // Consolidate Items for the Bill of Lading Cargo Table
  // Same plant + size + notes merge; different notes stay separate (e.g. 24" vs 30" on B&B).
  interface BOLConsolidatedItem {
    plantName: string;
    containerSize: string;
    notes: string;
    totalQty: number;
  }

  const bolConsolidatedMap = new Map<string, BOLConsolidatedItem>();

  try {
    currentBOLOrders.forEach((order) => {
      (order.items || []).forEach((item) => {
        const notes = String(item.notes || '').trim();
        const key = `${(item.plantName || '').toLowerCase()}::${(item.containerSize || '').toLowerCase()}::${notes.toLowerCase()}`;

        if (!bolConsolidatedMap.has(key)) {
          bolConsolidatedMap.set(key, {
            plantName: item.plantName || t('bol.defaultPlant'),
            containerSize: item.containerSize || '',
            notes,
            totalQty: 0,
          });
        }

        const existing = bolConsolidatedMap.get(key)!;
        existing.totalQty += item.quantity || 0;
      });
    });
  } catch (err) {
    console.error('[BOL] Failed consolidating cargo:', err);
  }

  const consolidatedItems = Array.from(bolConsolidatedMap.values()).sort(
    (a, b) =>
      a.plantName.localeCompare(b.plantName) ||
      a.containerSize.localeCompare(b.containerSize) ||
      a.notes.localeCompare(b.notes)
  );

  function orderStopRef(order: CustomerOrder | null | undefined): string {
    if (!order) return '—';
    return orderRefLabel(order) || '—';
  }

  // Dynamic BOL Number
  const bolNumber = selectedBOLType === 'consolidated'
    ? `BOL-${String(truck?.id || 'TRUCK').substring(0, 6).toUpperCase()}-${new Date(shipDate).getFullYear()}`
    : `BOL-${String(singleOrder?.id || 'ORD').substring(0, 6).toUpperCase()}-${new Date(shipDate).getFullYear()}`;

  const handleDownloadPdf = async () => {
    setIsGeneratingPdf(true);
    try {
      const pdf = new jsPDF('p', 'pt', 'letter');
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 36;
      let y = margin;

      const ensureSpace = (needed = 18): void => {
        if (y + needed > pageHeight - margin) {
          pdf.addPage();
          y = margin;
        }
      };

      const writeLine = (text: string, x = margin, size = 10, bold = false, spacing = 14): void => {
        ensureSpace(spacing);
        pdf.setFont('helvetica', bold ? 'bold' : 'normal');
        pdf.setFontSize(size);
        pdf.setTextColor(20, 20, 20);
        pdf.text(text, x, y);
        y += spacing;
      };

      const writeWrapped = (
        text: string,
        x: number,
        width: number,
        size = 10,
        bold = false,
        spacing = 13
      ): void => {
        pdf.setFont('helvetica', bold ? 'bold' : 'normal');
        pdf.setFontSize(size);
        pdf.setTextColor(35, 35, 35);
        const lines = pdf.splitTextToSize(text, width);
        lines.forEach((line: string) => {
          ensureSpace(spacing);
          pdf.text(line, x, y);
          y += spacing;
        });
      };

      const drawSectionTitle = (title: string): void => {
        ensureSpace(22);
        pdf.setFillColor(240, 247, 242);
        pdf.rect(margin, y - 12, pageWidth - margin * 2, 18, 'F');
        pdf.setFont('helvetica', 'bold');
        pdf.setFontSize(10);
        pdf.setTextColor(23, 93, 63);
        pdf.text(title.toUpperCase(), margin + 8, y);
        y += 18;
      };

      const box = (x: number, top: number, w: number, h: number): void => {
        pdf.setDrawColor(205, 219, 211);
        pdf.setLineWidth(0.8);
        pdf.roundedRect(x, top, w, h, 6, 6);
      };

      // Header with nursery logo (when available)
      const headerTop = y;
      let textX = margin;
      if (logoSrc) {
        try {
          const logo = await Promise.race([
            imageSrcToDataUrl(logoSrc),
            new Promise<never>((_, reject) => {
              window.setTimeout(() => reject(new Error('logo timeout')), 4000);
            })
          ]);
          const logoSize = 52;
          pdf.addImage(logo.dataUrl, logo.format, margin, headerTop, logoSize, logoSize);
          textX = margin + logoSize + 12;
        } catch (logoErr) {
          console.warn('BOL logo could not be embedded in PDF:', logoErr);
        }
      }

      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(16);
      pdf.setTextColor(20, 20, 20);
      pdf.text((nurseryName || 'NurseryOS').toUpperCase(), textX, headerTop + 18);
      pdf.setFontSize(12);
      pdf.text(t('bol.billOfLading'), textX, headerTop + 34);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      pdf.setTextColor(60, 60, 60);
      pdf.text(
        selectedBOLType === 'consolidated'
          ? t('bol.consolidatedShipment')
          : t('bol.individualShipment'),
        textX,
        headerTop + 48
      );
      y = headerTop + (logoSrc ? 64 : 56);

      const infoTop = y + 4;
      box(margin, infoTop, pageWidth - margin * 2, 78);
      y = infoTop + 18;
      writeLine(t('bol.pdfBolNumber', { num: bolNumber }), margin + 10, 10, true, 14);
      writeLine(
        t('bol.pdfShipDate', { date: new Date(shipDate).toLocaleDateString(locale) }),
        margin + 10,
        10,
        false,
        14
      );
      writeLine(
        t('bol.pdfCustomerPo', { po: poNumber.trim() || t('bol.na') }),
        margin + 10,
        10,
        false,
        14
      );
      writeLine(
        t('bol.pdfCarrier', { carrier: truck.carrier || t('bol.privateFleet') }),
        margin + 210,
        10,
        false,
        14
      );
      writeLine(t('bol.pdfTruckUnit', { unit: truckNumber || t('bol.na') }), margin + 210, 10, false, 14);
      writeLine(
        t('bol.pdfTrailerSeal', {
          trailer: trailerNumber || t('bol.na'),
          seal: sealNumber || t('bol.na')
        }),
        margin + 390,
        10,
        false,
        14
      );
      y = infoTop + 90;

      drawSectionTitle(t('bol.pdfShipper'));
      writeWrapped(`${nurseryName}\n${shipperAddress}`, margin + 4, pageWidth - margin * 2 - 8, 10, false, 13);
      y += 2;

      drawSectionTitle(
        selectedBOLType === 'consolidated' ? t('bol.pdfStopsConsignees') : t('bol.pdfConsignee')
      );
      currentBOLOrders.forEach((order, idx) => {
        const stopLabel = blindBol
          ? selectedBOLType === 'consolidated'
            ? t('bol.pdfStopBlind', { n: idx + 1, num: orderStopRef(order) })
            : t('bol.pdfConsigneeBlind', { num: orderStopRef(order) })
          : selectedBOLType === 'consolidated'
            ? t('bol.pdfStopOrder', {
                n: idx + 1,
                customer: resolveOrderReceiverName(order),
                num: orderStopRef(order)
              })
            : `${resolveOrderReceiverName(order)}${
                orderStopRef(order) !== '—' ? ` (${orderStopRef(order)})` : ''
              }`;
        writeWrapped(stopLabel, margin + 4, pageWidth - margin * 2 - 8, 10, true, 13);
        const addr = stopDeliveryAddress(order);
        if (addr) {
          writeWrapped(
            t('bol.pdfReceiverAddress', { address: addr }),
            margin + 4,
            pageWidth - margin * 2 - 8,
            10,
            false,
            13
          );
        }
        const contact = stopContact(order);
        if (contact && !blindBol) {
          writeWrapped(
            t('bol.pdfPointOfContact', { contact }),
            margin + 4,
            pageWidth - margin * 2 - 8,
            10,
            false,
            13
          );
        }
      });
      y += 4;

      drawSectionTitle(t('bol.pdfCargoManifest'));
      ensureSpace(26);
      const xPlant = margin + 6;
      const xSize = margin + 300;
      const xQty = margin + 400;
      const xCheck = margin + 480;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(80, 80, 80);
      pdf.text(t('bol.pdfPlantName'), xPlant, y);
      pdf.text(t('bol.pdfSize'), xSize, y);
      pdf.text(t('bol.pdfQty'), xQty, y);
      pdf.text(t('bol.pdfReceived'), xCheck, y);
      y += 8;
      pdf.setDrawColor(185, 185, 185);
      pdf.line(margin, y, pageWidth - margin, y);
      y += 12;

      consolidatedItems.forEach((item) => {
        const noteLines = item.notes
          ? pdf.splitTextToSize(item.notes, xSize - xPlant - 8)
          : [];
        ensureSpace(16 + noteLines.length * 10);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
        pdf.setTextColor(25, 25, 25);
        const plant = item.plantName.length > 38 ? `${item.plantName.slice(0, 38)}...` : item.plantName;
        pdf.text(plant, xPlant, y);
        pdf.text(item.containerSize, xSize, y);
        pdf.text(String(item.totalQty), xQty, y);
        // Empty checkbox for customer to check off received material
        pdf.setDrawColor(90, 90, 90);
        pdf.setLineWidth(0.8);
        pdf.rect(xCheck + 4, y - 7, 10, 10);
        pdf.setLineWidth(0.2);
        if (noteLines.length > 0) {
          y += 11;
          pdf.setFontSize(8);
          pdf.setTextColor(90, 90, 90);
          noteLines.forEach((line: string) => {
            pdf.text(line, xPlant, y);
            y += 10;
          });
          y += 2;
        } else {
          y += 14;
        }
      });
      ensureSpace(16);
      pdf.line(margin, y, pageWidth - margin, y);
      y += 12;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.setTextColor(18, 65, 46);
      pdf.text(t('bol.pdfTotalPlants', { n: totalPlants.toLocaleString(locale) }), margin + 4, y);
      y += 12;

      drawSectionTitle(t('bol.pdfSpecialInstructions'));
      writeWrapped(specialInstructions || t('bol.na'), margin + 4, pageWidth - margin * 2 - 8, 10, false, 13);

      ensureSpace(28);
      y += 6;
      pdf.setDrawColor(190, 190, 190);
      pdf.line(margin, y, margin + 220, y);
      pdf.line(margin + 280, y, margin + 500, y);
      y += 12;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(90, 90, 90);
      pdf.text(t('bol.pdfShipperSignature'), margin, y);
      pdf.text(t('bol.pdfCarrierSignature'), margin + 280, y);

      const fileName = `${bolNumber}.pdf`;
      const result = await deliverPdfBlob(pdf.output('blob'), fileName);
      if (result.method === 'preview') {
        setPdfSheet({
          url: result.url,
          fileName: result.fileName,
          blob: result.blob
        });
      }
    } catch (err) {
      console.error('Failed to generate BOL PDF:', err);
      alert(
        `${t('bol.generateFailed')} ${err instanceof Error ? err.message : t('bol.na')}`
      );
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-start overflow-y-auto p-4 md:p-8 z-[200] print:p-0 print:bg-white print:backdrop-blur-none"
      role="dialog"
      aria-modal="true"
      aria-label={t('bol.title')}
    >
      {pdfSheet && (
        <PdfShareSheet
          url={pdfSheet.url}
          fileName={pdfSheet.fileName}
          blob={pdfSheet.blob}
          title={t('bol.ready')}
          onClose={() => setPdfSheet(null)}
        />
      )}
      
      {/* Modal Container */}
      <div className="bg-white w-full max-w-5xl rounded-3xl border border-gray-150 shadow-2xl overflow-hidden flex flex-col md:flex-row print:shadow-none print:border-none print:rounded-none my-auto">
        
        {/* Left Side: Customize Form (Hidden during print) */}
        <div className="w-full md:w-80 bg-slate-50 border-r border-gray-150 p-6 flex flex-col space-y-5 shrink-0 print:hidden">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-black text-gray-900 font-sans tracking-tight uppercase flex items-center">
              <FileText className="h-4 w-4 mr-2 text-ink-800" />
              {t('bol.customize')}
            </h3>
            <button
              onClick={onClose}
              className="md:hidden p-1.5 rounded-lg hover:bg-gray-200 text-gray-400 hover:text-gray-900 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={handleDownloadPdf}
            disabled={isGeneratingPdf}
            className="md:hidden w-full py-3 px-4 bg-ink-800 hover:bg-ink-900 disabled:opacity-60 text-white rounded-xl text-xs font-black shadow-sm flex items-center justify-center space-x-2"
          >
            <Printer className="h-4 w-4" />
            <span>
              {isGeneratingPdf
                ? t('bol.generating')
                : selectedBOLType === 'consolidated'
                  ? t('bol.downloadConsolidated')
                  : t('bol.downloadOrder')}
            </span>
          </button>

          <div className="space-y-4 text-xs">
            {/* Blind BOL — hide customer name on printed document */}
            <button
              type="button"
              onClick={() => setBlindBol((v) => !v)}
              className={`w-full flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                blindBol
                  ? 'border-ink-400 bg-ink-100/70 text-ink-950'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-ink-200'
              }`}
              aria-pressed={blindBol}
            >
              <EyeOff
                className={`h-4 w-4 mt-0.5 shrink-0 ${blindBol ? 'text-ink-800' : 'text-gray-400'}`}
              />
              <span className="min-w-0">
                <span className="block font-black uppercase tracking-wider text-[10px] font-mono">
                  {t('bol.blindBol')}
                  {blindBol ? ` · ${t('bol.blindBolOn')}` : ''}
                </span>
                <span className="block mt-0.5 text-[10px] font-medium leading-snug text-gray-600">
                  {t('bol.blindBolHint')}
                </span>
              </span>
            </button>

            {/* BOL Type Selection */}
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1.5 uppercase tracking-wider text-[10px]">
                {t('bol.selection')}
              </label>
              <select
                value={selectedBOLType}
                onChange={(e) => handleBolTypeChange(e.target.value)}
                className="w-full px-3 py-2 border border-ink-200 rounded-xl focus:outline-none focus:border-ink-500 bg-ink-50/40 font-semibold text-gray-800 text-xs"
              >
                <option value="consolidated">{t('bol.consolidated')}</option>
                {sortedOrders.map((order, idx) => (
                  <option key={order.id} value={order.id}>
                    {t('bol.stopOrder', {
                      n: idx + 1,
                      num: orderStopRef(order),
                      customer: String(order.customerName || t('reports.customer')).slice(0, 25)
                    })}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {t('bol.shipDate')}
              </label>
              <input
                type="date"
                value={shipDate}
                onChange={(e) => setShipDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {t('bol.customerPo')}
              </label>
              <input
                type="text"
                value={poNumber}
                placeholder={t('bol.customerPoHint')}
                onChange={(e) => setPoNumber(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {t('bol.shipperAddress')}
              </label>
              <textarea
                rows={3}
                value={shipperAddress}
                onChange={(e) => setShipperAddress(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {t('bol.driverName')}
              </label>
              <input
                type="text"
                value={driverName}
                placeholder={t('bol.driverPlaceholder')}
                onChange={(e) => setDriverName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {t('bol.truckNumber')}
              </label>
              <input
                type="text"
                value={truckNumber}
                onChange={(e) => setTruckNumber(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {t('bol.trailerNumber')}
              </label>
              <input
                type="text"
                value={trailerNumber}
                placeholder={t('bol.trailerPlaceholder')}
                onChange={(e) => setTrailerNumber(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {t('bol.sealNumber')}
              </label>
              <input
                type="text"
                value={sealNumber}
                placeholder={t('bol.sealPlaceholder')}
                onChange={(e) => setSealNumber(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {t('bol.receiverAddress')}
              </label>
              <textarea
                rows={3}
                value={receiverAddress}
                placeholder={t('bol.receiverPlaceholder')}
                onChange={(e) => setReceiverAddress(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {t('bol.pointOfContact')}
              </label>
              <input
                type="text"
                value={receiverContact}
                placeholder={t('bol.pocPlaceholder')}
                onChange={(e) => setReceiverContact(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                {t('bol.specialInstructions')}
              </label>
              <textarea
                rows={3}
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-medium"
              />
            </div>
          </div>

          {/* Sticky on mobile so Download stays reachable after scrolling the long form. */}
          <div className="pt-4 border-t border-gray-200 flex flex-col space-y-2 sticky bottom-0 bg-slate-50 -mx-6 px-6 pb-2 md:static md:mx-0 md:px-0 md:pb-0">
            {onSaveBolDraft && (
              <>
                <button
                  type="button"
                  onClick={() => void handleSaveBolDraft()}
                  disabled={isSavingDraft}
                  className={`w-full py-3 px-4 rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2 ${
                    saveDraftSuccess
                      ? 'bg-ink-600 text-white'
                      : 'bg-white border border-ink-200 hover:bg-ink-50 text-ink-900'
                  }`}
                >
                  {saveDraftSuccess ? (
                    <CheckCircle className="h-4 w-4" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  <span>
                    {isSavingDraft
                      ? t('bol.savingDraft')
                      : saveDraftSuccess
                        ? t('bol.draftSaved')
                        : t('bol.saveDraft')}
                  </span>
                </button>
                <p className="text-[10px] text-slate-500 text-center leading-snug">
                  {t('bol.saveDraftHint')}
                </p>
                {saveDraftError && (
                  <p className="text-[10px] text-rose-700 text-center">{saveDraftError}</p>
                )}
              </>
            )}
            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={isGeneratingPdf}
              className="w-full py-3 px-4 bg-ink-800 hover:bg-ink-900 disabled:opacity-60 text-white rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2"
            >
              <Printer className="h-4 w-4" />
              <span>
                {isGeneratingPdf
                  ? t('bol.generating')
                  : selectedBOLType === 'consolidated'
                    ? t('bol.downloadConsolidated')
                    : t('bol.downloadOrder')}
              </span>
            </button>
            <p className="text-[10px] text-slate-500 text-center md:hidden">{t('bol.phoneHint')}</p>
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2.5 px-4 bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 rounded-xl text-xs font-bold transition-all flex items-center justify-center"
            >
              {t('bol.closePreview')}
            </button>
          </div>
        </div>

        {/* Right Side / Document Preview (Becomes full-page on print) */}
        <div className="flex-1 bg-white p-6 md:p-10 flex flex-col min-h-0 print:p-0">
          
          {/* Action header inside modal (Hidden during print) */}
          <div className="flex justify-between items-center pb-4 mb-6 border-b border-gray-150 print:hidden">
            <div>
              <h2 className="text-base font-black text-gray-900 flex items-center gap-2 flex-wrap">
                {selectedBOLType === 'consolidated'
                  ? t('bol.consolidatedTitle')
                  : t('bol.orderTitle', { num: orderStopRef(singleOrder) })}
                {blindBol && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-ink-100 text-ink-900 border border-ink-200">
                    <EyeOff className="h-3 w-3" />
                    {t('bol.blindBol')}
                  </span>
                )}
              </h2>
              <p className="text-[10px] text-gray-500 mt-0.5 font-sans">{t('bol.previewBody')}</p>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={handleDownloadPdf}
                disabled={isGeneratingPdf}
                className="p-2 bg-ink-50 border border-ink-100 rounded-xl text-ink-800 hover:bg-ink-100 transition-colors"
                title={t('bol.downloadPdf')}
              >
                <Printer className="h-4 w-4" />
              </button>
              <button
                onClick={onClose}
                className="p-2 hover:bg-gray-100 border border-gray-200 rounded-xl text-gray-500 hover:text-gray-900 transition-colors"
                title={t('bol.closeWindow')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Printable Document Sheet */}
          <div className="flex-1 overflow-y-auto pr-2 print:overflow-visible print:pr-0">
            <div className="border border-gray-300 p-8 rounded-lg bg-white shadow-inner max-w-4xl mx-auto print:border-none print:shadow-none print:p-0 text-gray-900 font-sans leading-normal">
              
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
                }
              `}} />

              {/* Document Header */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pb-6 border-b border-gray-300">
                <div className="flex items-start gap-3">
                  {logoSrc ? (
                    <img
                      src={logoSrc}
                      alt={t('bol.logoAlt', { name: nurseryName })}
                      className="h-16 w-16 sm:h-20 sm:w-20 object-contain rounded-xl border border-ink-100 bg-white shadow-sm shrink-0"
                    />
                  ) : null}
                  <div className="min-w-0">
                    <h1 className="text-xl font-black tracking-tight text-ink-950 uppercase">
                      {nurseryName}
                    </h1>
                    <p className="text-xs text-gray-500 font-mono font-bold mt-1 uppercase tracking-wide">
                      {t('bol.wholesaleTagline')}
                    </p>
                    <p className="text-[11px] text-gray-600 mt-3 whitespace-pre-line font-mono font-bold leading-relaxed text-ink-900/90">
                      {shipperAddress}
                    </p>
                  </div>
                </div>
                <div className="sm:text-right flex flex-col sm:justify-between items-start sm:items-end">
                  <div className="border border-gray-300 rounded-lg p-3 bg-slate-50 inline-block text-left">
                    <span className="block text-[10px] font-bold text-gray-400 font-mono uppercase tracking-wide">
                      {selectedBOLType === 'consolidated'
                        ? t('bol.consolidatedBolNumber')
                        : t('bol.individualBolNumber')}
                    </span>
                    <span className="text-base font-mono font-black text-gray-900">
                      {bolNumber}
                    </span>
                  </div>
                  <div className="mt-4 text-left sm:text-right font-mono text-[11px]">
                    <p className="text-gray-500 font-bold uppercase text-[9px] tracking-wider mb-0.5">
                      {t('bol.shipmentLogistics')}
                    </p>
                    <p className="text-gray-800">
                      <span className="font-bold text-gray-500">{t('bol.dateLabel')}</span>{' '}
                      {new Date(shipDate).toLocaleDateString(locale, { dateStyle: 'long' })}
                    </p>
                    {poNumber.trim() && (
                      <p className="text-gray-800">
                        <span className="font-bold text-gray-500">{t('bol.poLabel')}</span>{' '}
                        <span className="font-black text-gray-900">{poNumber}</span>
                      </p>
                    )}
                    <p className="text-gray-800">
                      <span className="font-bold text-gray-500">{t('bol.truckTypeLabel')}</span>{' '}
                      {truck.truckType || t('bol.na')}
                    </p>
                    <p className="text-gray-800">
                      <span className="font-bold text-gray-500">{t('bol.carrierLabel')}</span>{' '}
                      {truck.carrier || t('bol.privateFleet')}
                    </p>
                  </div>
                </div>
              </div>

              {/* Parties Section */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-6 border-b border-gray-300">
                <div>
                  <h3 className="text-xs font-bold font-mono uppercase text-gray-500 tracking-wider mb-3">
                    {t('bol.shipperOrigin')}
                  </h3>
                  <div className="text-[11px] text-gray-800 font-medium leading-relaxed">
                    <p className="font-black text-xs text-gray-950">BAYOU STATE PLANT CO</p>
                    <p className="mt-1 font-semibold">{t('bol.nurseryLoading')}</p>
                    <p className="mt-2 text-gray-400 font-mono text-[10px] uppercase font-bold tracking-wider">
                      {t('bol.mailingPickup')}
                    </p>
                    <p className="font-mono whitespace-pre-wrap mt-0.5 text-gray-700 leading-normal">{shipperAddress}</p>
                    <p className="mt-2">{t('bol.phone')}</p>
                    <p>{t('bol.logisticsContact')}</p>
                  </div>
                </div>
                <div>
                  <h3 className="text-xs font-bold font-mono uppercase text-gray-500 tracking-wider mb-3">
                    {t('bol.carrierEquipment')}
                  </h3>
                  <div className="text-[11px] text-gray-800 font-mono space-y-1">
                    <p><span className="font-bold text-gray-500">{t('bol.carrierName')}</span> <span className="font-bold text-gray-900">{truck.carrier || t('bol.privateFleetParenthetical', { name: nurseryName })}</span></p>
                    <p><span className="font-bold text-gray-500">{t('bol.driverNameLabel')}</span> <span className="font-bold text-gray-900">{driverName || t('bol.blankLine')}</span></p>
                    <p><span className="font-bold text-gray-500">{t('bol.truckTractor')}</span> <span className="font-bold text-gray-900">{truckNumber || t('bol.na')}</span></p>
                    <p><span className="font-bold text-gray-500">{t('bol.trailerNumberLabel')}</span> <span className="font-bold text-gray-900">{trailerNumber || t('bol.blankLine')}</span></p>
                    {sealNumber && (
                      <p><span className="font-bold text-gray-500">{t('bol.sealNumberLabel')}</span> <span className="font-bold text-gray-900">{sealNumber}</span></p>
                    )}
                  </div>
                </div>
              </div>

              {/* Delivery Stop / Consignee Destination Section */}
              {selectedBOLType === 'consolidated' ? (
                /* Consolidated Route view */
                <div className="py-6 border-b border-gray-300">
                  <h3 className="text-xs font-bold font-mono uppercase text-gray-500 tracking-wider mb-3">
                    {t('bol.deliveryRoute')}
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {sortedOrders.map((order, index) => {
                      const totalItems = order.items.reduce((sum, item) => sum + item.quantity, 0);
                      const stopAddress = stopDeliveryAddress(order);
                      const contact = stopContact(order);
                      return (
                        <div
                          key={order.id}
                          className="border border-gray-200 p-3 rounded-lg bg-slate-50 font-sans"
                        >
                          <div className="flex items-center justify-between gap-1 mb-1.5">
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-black font-mono bg-ink-100 text-ink-900 border border-ink-200 uppercase">
                              {t('bol.stop', { n: index + 1 })}
                            </span>
                            <span className="text-[10px] text-gray-400 font-mono font-medium">
                              {t('bol.orderNum', { num: orderStopRef(order) })}
                            </span>
                          </div>
                          {!blindBol && (
                            <p className="text-xs font-black text-gray-950 truncate">
                              {resolveOrderReceiverName(order)}
                            </p>
                          )}
                          <p
                            className={`text-xs text-gray-800 whitespace-pre-wrap leading-snug ${
                              blindBol ? '' : 'mt-1'
                            }`}
                          >
                            {stopAddress || t('bol.deliveryAddressOnly')}
                          </p>
                          {contact && !blindBol && (
                            <p className="text-[10px] text-gray-600 mt-1 leading-snug">
                              {contact}
                            </p>
                          )}
                          <div className="text-[10px] text-gray-500 font-mono mt-1 pt-1.5 border-t border-gray-200/50">
                            <span>{t('bol.plants', { n: totalItems })}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                /* Individual Consignee view */
                <div className="py-6 border-b border-gray-300">
                  <h3 className="text-xs font-bold font-mono uppercase text-gray-500 tracking-wider mb-3">
                    {t('bol.consigneeDestination')}
                  </h3>
                  <div className="border border-gray-300 p-4 rounded-xl bg-slate-50 font-sans max-w-xl">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-black font-mono bg-ink-100 text-ink-900 border border-ink-200 uppercase">
                        {blindBol
                          ? t('bol.deliveryDestination')
                          : t('bol.activeConsignee', {
                              n: sortedOrders.indexOf(singleOrder!) + 1
                            })}
                      </span>
                      <span className="text-xs font-mono font-bold text-gray-500">
                        {t('bol.orderNum', { num: orderStopRef(singleOrder) })}
                      </span>
                    </div>
                    {!blindBol && singleOrder && (
                      <p className="text-sm font-black text-gray-950">
                        {resolveOrderReceiverName(singleOrder)}
                      </p>
                    )}
                    <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                      {blindBol
                        ? t('bol.blindDeliverInstruction', { num: orderStopRef(singleOrder) })
                        : t('bol.deliverInstruction', { num: orderStopRef(singleOrder) })}
                    </p>
                    {(receiverAddress ||
                      (singleOrder && resolveOrderDeliveryAddress(singleOrder))) && (
                      <p className="text-xs text-gray-700 mt-2 leading-relaxed whitespace-pre-wrap">
                        <span className="font-bold text-gray-500">{t('bol.receiverAddressLabel')}</span>{' '}
                        {receiverAddress ||
                          (singleOrder ? resolveOrderDeliveryAddress(singleOrder) : '')}
                      </p>
                    )}
                    {receiverContact && !blindBol && (
                      <p className="text-xs text-gray-700 mt-1 leading-relaxed">
                        <span className="font-bold text-gray-500">{t('bol.pointOfContactLabel')}</span>{' '}
                        {receiverContact}
                      </p>
                    )}
                    <div className="text-[10px] text-gray-500 font-mono mt-3 pt-2.5 border-t border-gray-200/50">
                      <span>{t('bol.shipmentCargo', { n: totalPlants })}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Plant Load Table */}
              <div className="py-6 border-b border-gray-300">
                <div className="flex justify-between items-baseline mb-3">
                  <h3 className="text-xs font-bold font-mono uppercase text-gray-500 tracking-wider">
                    {selectedBOLType === 'consolidated'
                      ? t('bol.consolidatedManifest')
                      : t('bol.orderManifest', { num: orderStopRef(singleOrder) })}
                  </h3>
                  <span className="text-[10px] font-mono font-bold text-gray-400">
                    {selectedBOLType === 'consolidated'
                      ? t('bol.groupedTotals')
                      : t('bol.orderTotals')}
                  </span>
                </div>
                
                <table className="w-full text-left border-collapse font-sans">
                  <thead>
                    <tr className="border-b-2 border-gray-300 text-gray-500 text-[9px] font-bold font-mono uppercase tracking-wider">
                      <th className="pb-2">{t('bol.plantVariety')}</th>
                      <th className="pb-2 w-28">{t('bol.containerSize')}</th>
                      <th className="pb-2 text-center w-20">{t('common.qty')}</th>
                      <th className="pb-2 text-center w-16">{t('bol.received')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {consolidatedItems.map((item, index) => (
                      <tr
                        key={index}
                        className="border-b border-gray-200 text-xs font-medium text-gray-800"
                      >
                        <td className="py-2.5 font-bold text-gray-950">
                          <div>{item.plantName}</div>
                          {item.notes ? (
                            <div className="mt-0.5 text-[10px] font-medium text-gray-500 leading-snug whitespace-pre-wrap">
                              {item.notes}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-2.5 font-mono text-gray-500">{item.containerSize}</td>
                        <td className="py-2.5 text-center font-mono font-black text-gray-950">
                          {item.totalQty}
                        </td>
                        <td className="py-2.5 text-center">
                          <span
                            className="inline-block w-4 h-4 border-2 border-gray-400 rounded-sm align-middle print:border-gray-700"
                            aria-hidden="true"
                          />
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 border-b-2 border-gray-300 font-bold text-gray-950 text-xs font-mono">
                      <td className="py-3 px-2 font-sans font-black" colSpan={2}>
                        {selectedBOLType === 'consolidated'
                          ? t('bol.grandTotalCargo')
                          : t('bol.shipmentTotalCargo')}
                      </td>
                      <td className="py-3 text-center">{totalPlants}</td>
                      <td className="py-3" />
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Special Instructions */}
              <div className="py-6 border-b border-gray-300 text-xs">
                <h3 className="text-xs font-bold font-mono uppercase text-gray-500 tracking-wider mb-2">
                  {t('bol.specialTransport')}
                </h3>
                <p className="bg-slate-50 border border-gray-200 rounded-lg p-3 text-gray-700 leading-relaxed font-sans italic whitespace-pre-wrap">
                  {specialInstructions}
                </p>
              </div>

              {/* Regulatory certification statement */}
              <div className="py-5 text-[9px] text-gray-500 leading-normal border-b border-gray-300">
                <p className="font-bold uppercase mb-1">{t('bol.shipperCertTitle')}</p>
                <p>{t('bol.shipperCertBody')}</p>
                <p className="mt-2">
                  <span className="font-bold">{t('bol.carrierAckTitle')}</span> {t('bol.carrierAckBody')}
                </p>
              </div>

              {/* Signature Blocks */}
              <div className="pt-6 grid grid-cols-1 md:grid-cols-2 gap-8 text-[11px] font-mono">
                <div className="space-y-6">
                  <div>
                    <p className="text-gray-400 font-bold uppercase text-[9px] tracking-wider mb-1">
                      {t('bol.shipperRep', { name: nurseryName })}
                    </p>
                    <div className="flex items-end pt-4 border-b border-gray-300">
                      <span className="text-[10px] text-gray-400 mr-2 shrink-0">{t('bol.signature')}</span>
                      <span className="flex-1"></span>
                    </div>
                    <div className="grid grid-cols-2 gap-4 mt-2">
                      <div className="flex items-end border-b border-gray-300">
                        <span className="text-[10px] text-gray-400 mr-2 shrink-0">{t('bol.printedName')}</span>
                        <span className="flex-1"></span>
                      </div>
                      <div className="flex items-end border-b border-gray-300">
                        <span className="text-[10px] text-gray-400 mr-2 shrink-0">{t('bol.dateField')}</span>
                        <span className="flex-1"></span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <p className="text-gray-400 font-bold uppercase text-[9px] tracking-wider mb-1">
                      {t('bol.carrierDriverCert')}
                    </p>
                    <div className="flex items-end pt-4 border-b border-gray-300">
                      <span className="text-[10px] text-gray-400 mr-2 shrink-0">{t('bol.driverSign')}</span>
                      <span className="flex-1"></span>
                    </div>
                    <div className="grid grid-cols-2 gap-4 mt-2">
                      <div className="flex items-end border-b border-gray-300">
                        <span className="text-[10px] text-gray-400 mr-2 shrink-0">{t('bol.printedName')}</span>
                        <span className="flex-1 font-sans font-bold text-xs pl-1">{driverName}</span>
                      </div>
                      <div className="flex items-end border-b border-gray-300">
                        <span className="text-[10px] text-gray-400 mr-2 shrink-0">{t('bol.dateField')}</span>
                        <span className="flex-1"></span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-6 bg-slate-50 border border-gray-250 p-4 rounded-lg">
                  <p className="text-gray-500 font-bold uppercase text-[9px] tracking-wider mb-1">
                    {t('bol.consigneeReceipt')}
                  </p>
                  <p className="text-[10px] text-gray-500 font-sans leading-normal mb-3">
                    {selectedBOLType === 'consolidated'
                      ? t('bol.consigneeReceiptConsolidated')
                      : t('bol.consigneeReceiptIndividual')}
                  </p>
                  
                  <div className="space-y-4">
                    {currentBOLOrders.map((order, index) => (
                      <div key={order.id} className="pt-2 border-t border-gray-200 first:border-none first:pt-0">
                        <p className="text-[10px] font-black text-gray-900 font-sans">
                          {blindBol
                            ? selectedBOLType === 'consolidated'
                              ? t('bol.stopBlind', {
                                  n: index + 1,
                                  num: orderStopRef(order)
                                })
                              : t('bol.pdfConsigneeBlind', { num: orderStopRef(order) })
                            : selectedBOLType === 'consolidated'
                              ? t('bol.stopCustomer', {
                                  n: index + 1,
                                  customer: resolveOrderReceiverName(order),
                                  num: orderStopRef(order)
                                })
                              : `${resolveOrderReceiverName(order)}${
                                  orderStopRef(order) !== '—'
                                    ? ` (${orderStopRef(order)})`
                                    : ''
                                }`}
                        </p>
                        <p className="text-[10px] text-gray-600 font-sans mt-1 whitespace-pre-wrap leading-snug">
                          {stopDeliveryAddress(order) || t('bol.deliveryAddressOnly')}
                        </p>
                        <div className="flex items-end pt-3 border-b border-gray-300">
                          <span className="text-[9px] text-gray-400 mr-2 shrink-0">{t('bol.receivedBy')}</span>
                          <span className="flex-1"></span>
                        </div>
                        <div className="flex items-end pt-2 border-b border-gray-300">
                          <span className="text-[9px] text-gray-400 mr-2 shrink-0">{t('bol.dateTime')}</span>
                          <span className="flex-1"></span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Page Number / Footer */}
              <div className="pt-10 text-center text-[9px] text-gray-400 font-mono">
                {selectedBOLType === 'consolidated'
                  ? t('bol.footerConsolidated', { name: nurseryName })
                  : t('bol.footerIndividual', { name: nurseryName, num: orderStopRef(singleOrder) })}
              </div>

            </div>
          </div>

        </div>

      </div>

    </div>,
    document.body
  );
};
