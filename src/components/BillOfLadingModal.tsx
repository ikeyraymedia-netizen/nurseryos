import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Truck, CustomerOrder, ContainerWeight } from '../types';
import { X, Printer, Truck as TruckIcon, User, Calendar, FileText, CheckCircle, Ship, MapPin } from 'lucide-react';
import jsPDF from 'jspdf';
import { deliverPdfBlob } from '../lib/downloadPdf';
import { PdfShareSheet } from './PdfShareSheet';
import { imageSrcToDataUrl, resolveNurseryLogoSrc } from '../lib/nurseryBranding';

interface BillOfLadingModalProps {
  isOpen: boolean;
  onClose: () => void;
  truck: Truck;
  orders: CustomerOrder[];
  containerWeights: ContainerWeight[];
  nurseryName?: string;
  /** Ship-from / origin address for the nursery. */
  nurseryAddress?: string;
  /** Nursery logo image URL (resolved from tenant branding). */
  nurseryLogoSrc?: string | null;
}

export const BillOfLadingModal: React.FC<BillOfLadingModalProps> = ({
  isOpen,
  onClose,
  truck,
  orders = [],
  nurseryName = 'NurseryOS',
  nurseryAddress = '',
  nurseryLogoSrc = null,
}) => {
  const logoSrc = nurseryLogoSrc || resolveNurseryLogoSrc(nurseryName);
  const truckName = String(truck?.name || 'Truck');
  const orderIds = Array.isArray(truck?.orderIds) ? truck.orderIds : [];
  const safeOrders = Array.isArray(orders) ? orders : [];

  // Sort orders by the designated loading sequence on the truck
  const sortedOrders = safeOrders
    .filter((o) => orderIds.includes(o.id) || o.truckId === truck?.id)
    .sort((a, b) => {
      const idxA = orderIds.indexOf(a.id);
      const idxB = orderIds.indexOf(b.id);
      if (idxA === -1) return 1;
      if (idxB === -1) return -1;
      return idxA - idxB;
    });

  // State for document selection: 'consolidated' or a specific customer order ID
  const [selectedBOLType, setSelectedBOLType] = useState<'consolidated' | string>('consolidated');

  // State for customizable document fields
  const [shipperAddress, setShipperAddress] = useState(
    nurseryAddress
      ? `${nurseryName}\n${nurseryAddress}`
      : `${nurseryName}\nNursery Loading Facility`
  );
  const [shipDate, setShipDate] = useState(
    truck?.loadingDate || new Date().toISOString().split('T')[0]
  );
  const [driverName, setDriverName] = useState('');
  const [truckNumber, setTruckNumber] = useState(() => {
    const match = truckName.match(/\d+/);
    return match ? `Truck #${match[0]}` : 'Unit 401';
  });
  const [trailerNumber, setTrailerNumber] = useState('');
  const [sealNumber, setSealNumber] = useState('');
  const [receiverAddress, setReceiverAddress] = useState('');
  const [receiverContact, setReceiverContact] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [specialInstructions, setSpecialInstructions] = useState(
    truck?.notes || 'Handle with care. Protect from extreme heat. Secure loads.'
  );
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfSheet, setPdfSheet] = useState<{
    url: string;
    fileName: string;
    blob: Blob;
  } | null>(null);

  // Prefill the customer PO # from the selected order(s)' saved invoice details.
  // MUST stay above any early return — calling useEffect only when isOpen flips
  // true crashes React ("Rendered more hooks than during the previous render").
  useEffect(() => {
    if (!isOpen) return;
    const scoped =
      selectedBOLType === 'consolidated'
        ? sortedOrders
        : sortedOrders.filter((o) => o.id === selectedBOLType);
    const pos = Array.from(
      new Set(
        scoped
          .map((o) => (o.invoiceDetails?.poNumber || '').trim())
          .filter(Boolean)
      )
    );
    setPoNumber(pos.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, selectedBOLType]);

  // Lock body scroll while open (helps mobile Safari keep the overlay visible).
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

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
  interface BOLConsolidatedItem {
    plantName: string;
    containerSize: string;
    totalQty: number;
  }

  const bolConsolidatedMap = new Map<string, BOLConsolidatedItem>();

  try {
    currentBOLOrders.forEach((order) => {
      (order.items || []).forEach((item) => {
        const key = `${(item.plantName || '').toLowerCase()}::${(item.containerSize || '').toLowerCase()}`;

        if (!bolConsolidatedMap.has(key)) {
          bolConsolidatedMap.set(key, {
            plantName: item.plantName || 'Plant',
            containerSize: item.containerSize || '',
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

  const consolidatedItems = Array.from(bolConsolidatedMap.values()).sort((a, b) => 
    a.plantName.localeCompare(b.plantName)
  );

  // Dynamic BOL Number
  const bolNumber = selectedBOLType === 'consolidated'
    ? `BOL-${String(truck?.id || 'TRUCK').substring(0, 6).toUpperCase()}-${new Date(shipDate).getFullYear()}`
    : `BOL-ORD-${(singleOrder?.orderNumber || '').toUpperCase()}-${new Date(shipDate).getFullYear()}`;

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
          const logo = await imageSrcToDataUrl(logoSrc);
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
      pdf.text('BILL OF LADING', textX, headerTop + 34);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(10);
      pdf.setTextColor(60, 60, 60);
      pdf.text(
        selectedBOLType === 'consolidated'
          ? 'Consolidated Truck Shipment'
          : 'Individual Order Shipment',
        textX,
        headerTop + 48
      );
      y = headerTop + (logoSrc ? 64 : 56);

      const infoTop = y + 4;
      box(margin, infoTop, pageWidth - margin * 2, 78);
      y = infoTop + 18;
      writeLine(`BOL Number: ${bolNumber}`, margin + 10, 10, true, 14);
      writeLine(`Ship Date: ${new Date(shipDate).toLocaleDateString()}`, margin + 10, 10, false, 14);
      writeLine(`Customer P.O. #: ${poNumber.trim() || 'N/A'}`, margin + 10, 10, false, 14);
      writeLine(`Carrier: ${truck.carrier || 'Private Fleet'}`, margin + 210, 10, false, 14);
      writeLine(`Truck/Unit: ${truckNumber || 'N/A'}`, margin + 210, 10, false, 14);
      writeLine(`Trailer: ${trailerNumber || 'N/A'}   Seal: ${sealNumber || 'N/A'}`, margin + 390, 10, false, 14);
      y = infoTop + 90;

      drawSectionTitle('Shipper');
      writeWrapped(`${nurseryName}\n${shipperAddress}`, margin + 4, pageWidth - margin * 2 - 8, 10, false, 13);
      y += 2;

      drawSectionTitle(selectedBOLType === 'consolidated' ? 'Stops / Consignees' : 'Consignee');
      currentBOLOrders.forEach((order, idx) => {
        writeWrapped(
          `${selectedBOLType === 'consolidated' ? `Stop ${idx + 1}: ` : ''}${order.customerName} (Order #${order.orderNumber})`,
          margin + 4,
          pageWidth - margin * 2 - 8,
          10,
          true,
          13
        );
      });
      if (receiverAddress.trim()) {
        writeWrapped(
          `Receiver Address: ${receiverAddress}`,
          margin + 4,
          pageWidth - margin * 2 - 8,
          10,
          false,
          13
        );
      }
      if (receiverContact.trim()) {
        writeWrapped(
          `Point of Contact: ${receiverContact}`,
          margin + 4,
          pageWidth - margin * 2 - 8,
          10,
          false,
          13
        );
      }
      y += 4;

      drawSectionTitle('Cargo Manifest');
      ensureSpace(26);
      const xPlant = margin + 6;
      const xSize = margin + 330;
      const xQty = margin + 440;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(80, 80, 80);
      pdf.text('Plant Name', xPlant, y);
      pdf.text('Size', xSize, y);
      pdf.text('Quantity', xQty, y);
      y += 8;
      pdf.setDrawColor(185, 185, 185);
      pdf.line(margin, y, pageWidth - margin, y);
      y += 12;

      consolidatedItems.forEach((item) => {
        ensureSpace(14);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(9);
        pdf.setTextColor(25, 25, 25);
        const plant = item.plantName.length > 42 ? `${item.plantName.slice(0, 42)}...` : item.plantName;
        pdf.text(plant, xPlant, y);
        pdf.text(item.containerSize, xSize, y);
        pdf.text(String(item.totalQty), xQty, y);
        y += 12;
      });
      ensureSpace(16);
      pdf.line(margin, y, pageWidth - margin, y);
      y += 12;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.setTextColor(18, 65, 46);
      pdf.text(`Total: ${totalPlants.toLocaleString()} plants`, margin + 4, y);
      y += 12;

      drawSectionTitle('Special Instructions');
      writeWrapped(specialInstructions || 'N/A', margin + 4, pageWidth - margin * 2 - 8, 10, false, 13);

      ensureSpace(28);
      y += 6;
      pdf.setDrawColor(190, 190, 190);
      pdf.line(margin, y, margin + 220, y);
      pdf.line(margin + 280, y, margin + 500, y);
      y += 12;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(90, 90, 90);
      pdf.text('Shipper Signature', margin, y);
      pdf.text('Carrier / Driver Signature', margin + 280, y);

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
        `Could not generate BOL PDF: ${err instanceof Error ? err.message : 'Unknown error'}`
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
      aria-label="Bill of Lading"
    >
      {pdfSheet && (
        <PdfShareSheet
          url={pdfSheet.url}
          fileName={pdfSheet.fileName}
          blob={pdfSheet.blob}
          title="Bill of Lading ready"
          onClose={() => setPdfSheet(null)}
        />
      )}
      
      {/* Modal Container */}
      <div className="bg-white w-full max-w-5xl rounded-3xl border border-gray-150 shadow-2xl overflow-hidden flex flex-col md:flex-row print:shadow-none print:border-none print:rounded-none my-auto">
        
        {/* Left Side: Customize Form (Hidden during print) */}
        <div className="w-full md:w-80 bg-slate-50 border-r border-gray-150 p-6 flex flex-col space-y-5 shrink-0 print:hidden">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-black text-gray-900 font-sans tracking-tight uppercase flex items-center">
              <FileText className="h-4 w-4 mr-2 text-emerald-800" />
              Customize BOL
            </h3>
            <button
              onClick={onClose}
              className="md:hidden p-1.5 rounded-lg hover:bg-gray-200 text-gray-400 hover:text-gray-900 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-4 text-xs">
            {/* BOL Type Selection */}
            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1.5 uppercase tracking-wider text-[10px]">
                BOL Selection
              </label>
              <select
                value={selectedBOLType}
                onChange={(e) => setSelectedBOLType(e.target.value)}
                className="w-full px-3 py-2 border border-emerald-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-emerald-50/40 font-semibold text-gray-800 text-xs"
              >
                <option value="consolidated">Consolidated Truck BOL (All Orders)</option>
                {sortedOrders.map((order, idx) => (
                  <option key={order.id} value={order.id}>
                    Stop {idx + 1}: Order #{order.orderNumber || '—'} -{' '}
                    {String(order.customerName || 'Customer').slice(0, 25)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Ship Date
              </label>
              <input
                type="date"
                value={shipDate}
                onChange={(e) => setShipDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Customer P.O. #
              </label>
              <input
                type="text"
                value={poNumber}
                placeholder="Customer purchase order number"
                onChange={(e) => setPoNumber(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Shipper Address Info
              </label>
              <textarea
                rows={3}
                value={shipperAddress}
                onChange={(e) => setShipperAddress(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Driver Name
              </label>
              <input
                type="text"
                value={driverName}
                placeholder="e.g. Bobby Smith"
                onChange={(e) => setDriverName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Truck/Unit Number
              </label>
              <input
                type="text"
                value={truckNumber}
                onChange={(e) => setTruckNumber(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Trailer Number
              </label>
              <input
                type="text"
                value={trailerNumber}
                placeholder="e.g. T-502"
                onChange={(e) => setTrailerNumber(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Seal Number (If applicable)
              </label>
              <input
                type="text"
                value={sealNumber}
                placeholder="e.g. SL-9092"
                onChange={(e) => setSealNumber(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Receiver Address
              </label>
              <textarea
                rows={3}
                value={receiverAddress}
                placeholder="Type receiver destination address"
                onChange={(e) => setReceiverAddress(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Point of Contact
              </label>
              <input
                type="text"
                value={receiverContact}
                placeholder="Name and phone/email"
                onChange={(e) => setReceiverContact(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
              />
            </div>

            <div>
              <label className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
                Special Transport Instructions
              </label>
              <textarea
                rows={3}
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl focus:outline-none focus:border-emerald-500 bg-white font-medium"
              />
            </div>
          </div>

          {/* Sticky on mobile so Download stays reachable after scrolling the long form. */}
          <div className="pt-4 border-t border-gray-200 flex flex-col space-y-2 sticky bottom-0 bg-slate-50 -mx-6 px-6 pb-2 md:static md:mx-0 md:px-0 md:pb-0">
            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={isGeneratingPdf}
              className="w-full py-3 px-4 bg-emerald-800 hover:bg-emerald-900 disabled:opacity-60 text-white rounded-xl text-xs font-black shadow-sm transition-all flex items-center justify-center space-x-2"
            >
              <Printer className="h-4 w-4" />
              <span>
                {isGeneratingPdf
                  ? 'Generating PDF...'
                  : `Download ${selectedBOLType === 'consolidated' ? 'Consolidated BOL' : 'Order BOL'} PDF`}
              </span>
            </button>
            <p className="text-[10px] text-slate-500 text-center md:hidden">
              On phone: Share sheet or in-app preview — the app stays open.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2.5 px-4 bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 rounded-xl text-xs font-bold transition-all flex items-center justify-center"
            >
              Close Preview
            </button>
          </div>
        </div>

        {/* Right Side / Document Preview (Becomes full-page on print) */}
        <div className="flex-1 bg-white p-6 md:p-10 flex flex-col min-h-0 print:p-0">
          
          {/* Action header inside modal (Hidden during print) */}
          <div className="flex justify-between items-center pb-4 mb-6 border-b border-gray-150 print:hidden">
            <div>
              <h2 className="text-base font-black text-gray-900">
                {selectedBOLType === 'consolidated' ? 'Consolidated Truck Bill of Lading' : `Bill of Lading: Order #${singleOrder?.orderNumber}`}
              </h2>
              <p className="text-[10px] text-gray-500 mt-0.5 font-sans">
                Below is the standard formatted Bill of Lading document ready to print.
              </p>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={handleDownloadPdf}
                disabled={isGeneratingPdf}
                className="p-2 bg-emerald-50 border border-emerald-100 rounded-xl text-emerald-800 hover:bg-emerald-100 transition-colors"
                title="Download PDF"
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
                      alt={`${nurseryName} logo`}
                      className="h-16 w-16 sm:h-20 sm:w-20 object-contain rounded-xl border border-emerald-100 bg-white shadow-sm shrink-0"
                    />
                  ) : null}
                  <div className="min-w-0">
                    <h1 className="text-xl font-black tracking-tight text-emerald-950 uppercase">
                      {nurseryName}
                    </h1>
                    <p className="text-xs text-gray-500 font-mono font-bold mt-1 uppercase tracking-wide">
                      Wholesale Foliage & Landscape Liners
                    </p>
                    <p className="text-[11px] text-gray-600 mt-3 whitespace-pre-line font-mono font-bold leading-relaxed text-emerald-900/90">
                      {shipperAddress}
                    </p>
                  </div>
                </div>
                <div className="sm:text-right flex flex-col sm:justify-between items-start sm:items-end">
                  <div className="border border-gray-300 rounded-lg p-3 bg-slate-50 inline-block text-left">
                    <span className="block text-[10px] font-bold text-gray-400 font-mono uppercase tracking-wide">
                      {selectedBOLType === 'consolidated' ? 'Consolidated BOL Number' : 'Individual Order BOL Number'}
                    </span>
                    <span className="text-base font-mono font-black text-gray-900">
                      {bolNumber}
                    </span>
                  </div>
                  <div className="mt-4 text-left sm:text-right font-mono text-[11px]">
                    <p className="text-gray-500 font-bold uppercase text-[9px] tracking-wider mb-0.5">Shipment Logistics</p>
                    <p className="text-gray-800">
                      <span className="font-bold text-gray-500">Date:</span> {new Date(shipDate).toLocaleDateString(undefined, { dateStyle: 'long' })}
                    </p>
                    {poNumber.trim() && (
                      <p className="text-gray-800">
                        <span className="font-bold text-gray-500">P.O. #:</span> <span className="font-black text-gray-900">{poNumber}</span>
                      </p>
                    )}
                    <p className="text-gray-800">
                      <span className="font-bold text-gray-500">Truck Type:</span> {truck.truckType || 'N/A'}
                    </p>
                    <p className="text-gray-800">
                      <span className="font-bold text-gray-500">Carrier:</span> {truck.carrier || 'Private Fleet'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Parties Section */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-6 border-b border-gray-300">
                <div>
                  <h3 className="text-xs font-bold font-mono uppercase text-gray-500 tracking-wider mb-3">
                    Shipper / Origin Point
                  </h3>
                  <div className="text-[11px] text-gray-800 font-medium leading-relaxed">
                    <p className="font-black text-xs text-gray-950">BAYOU STATE PLANT CO</p>
                    <p className="mt-1 font-semibold">Nursery loading facilities</p>
                    <p className="mt-2 text-gray-400 font-mono text-[10px] uppercase font-bold tracking-wider">Mailing & Pickup Address:</p>
                    <p className="font-mono whitespace-pre-wrap mt-0.5 text-gray-700 leading-normal">{shipperAddress}</p>
                    <p className="mt-2">Phone: (318) 748-0190</p>
                    <p>Contact your nursery office for logistics details</p>
                  </div>
                </div>
                <div>
                  <h3 className="text-xs font-bold font-mono uppercase text-gray-500 tracking-wider mb-3">
                    Carrier & Equipment Details
                  </h3>
                  <div className="text-[11px] text-gray-800 font-mono space-y-1">
                    <p><span className="font-bold text-gray-500">Carrier Name:</span> <span className="font-bold text-gray-900">{truck.carrier || `${nurseryName} (Private Fleet)`}</span></p>
                    <p><span className="font-bold text-gray-500">Driver Name:</span> <span className="font-bold text-gray-900">{driverName || '__________________________'}</span></p>
                    <p><span className="font-bold text-gray-500">Truck / Tractor #:</span> <span className="font-bold text-gray-900">{truckNumber || 'N/A'}</span></p>
                    <p><span className="font-bold text-gray-500">Trailer Number:</span> <span className="font-bold text-gray-900">{trailerNumber || '__________________________'}</span></p>
                    {sealNumber && (
                      <p><span className="font-bold text-gray-500">Seal Number:</span> <span className="font-bold text-gray-900">{sealNumber}</span></p>
                    )}
                  </div>
                </div>
              </div>

              {/* Delivery Stop / Consignee Destination Section */}
              {selectedBOLType === 'consolidated' ? (
                /* Consolidated Route view */
                <div className="py-6 border-b border-gray-300">
                  <h3 className="text-xs font-bold font-mono uppercase text-gray-500 tracking-wider mb-3">
                    Delivery Route & Sequence of Stops (All Shipments on Truck)
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {sortedOrders.map((order, index) => {
                      const totalItems = order.items.reduce((sum, item) => sum + item.quantity, 0);
                      return (
                        <div
                          key={order.id}
                          className="border border-gray-200 p-3 rounded-lg bg-slate-50 font-sans"
                        >
                          <div className="flex items-center justify-between gap-1 mb-1.5">
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-black font-mono bg-emerald-100 text-emerald-900 border border-emerald-200 uppercase">
                              Stop {index + 1}
                            </span>
                            <span className="text-[10px] text-gray-400 font-mono font-medium">
                              Order #{order.orderNumber}
                            </span>
                          </div>
                          <p className="text-xs font-black text-gray-950 truncate">
                            {order.customerName}
                          </p>
                          <div className="text-[10px] text-gray-500 font-mono mt-1 pt-1.5 border-t border-gray-200/50">
                            <span>{totalItems} plants</span>
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
                    Consignee / Delivery Destination
                  </h3>
                  <div className="border border-gray-300 p-4 rounded-xl bg-slate-50 font-sans max-w-xl">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[9px] font-black font-mono bg-emerald-100 text-emerald-900 border border-emerald-200 uppercase">
                        Active Consignee (Stop {sortedOrders.indexOf(singleOrder!) + 1})
                      </span>
                      <span className="text-xs font-mono font-bold text-gray-500">
                        Order #{singleOrder?.orderNumber}
                      </span>
                    </div>
                    <p className="text-sm font-black text-gray-950">
                      {singleOrder?.customerName}
                    </p>
                    <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                      Deliver this plant shipment directly to customer designated destination for Order #{singleOrder?.orderNumber}.
                    </p>
                    {receiverAddress && (
                      <p className="text-xs text-gray-700 mt-2 leading-relaxed">
                        <span className="font-bold text-gray-500">Receiver Address:</span> {receiverAddress}
                      </p>
                    )}
                    {receiverContact && (
                      <p className="text-xs text-gray-700 mt-1 leading-relaxed">
                        <span className="font-bold text-gray-500">Point of Contact:</span> {receiverContact}
                      </p>
                    )}
                    <div className="text-[10px] text-gray-500 font-mono mt-3 pt-2.5 border-t border-gray-200/50">
                      <span>Shipment Cargo: {totalPlants} plants</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Plant Load Table */}
              <div className="py-6 border-b border-gray-300">
                <div className="flex justify-between items-baseline mb-3">
                  <h3 className="text-xs font-bold font-mono uppercase text-gray-500 tracking-wider">
                    {selectedBOLType === 'consolidated' 
                      ? 'Consolidated Cargo Manifest (Itemized Bill of Lading)' 
                      : `Customer Cargo Manifest: Order #${singleOrder?.orderNumber}`
                    }
                  </h3>
                  <span className="text-[10px] font-mono font-bold text-gray-400">
                    {selectedBOLType === 'consolidated' ? 'Grouped Totals for Loading' : 'Order Shipment Totals'}
                  </span>
                </div>
                
                <table className="w-full text-left border-collapse font-sans">
                  <thead>
                    <tr className="border-b-2 border-gray-300 text-gray-500 text-[9px] font-bold font-mono uppercase tracking-wider">
                      <th className="pb-2">Plant Variety Name</th>
                      <th className="pb-2 w-28">Container Size</th>
                      <th className="pb-2 text-center w-24">Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {consolidatedItems.map((item, index) => (
                      <tr
                        key={index}
                        className="border-b border-gray-200 text-xs font-medium text-gray-800"
                      >
                        <td className="py-2.5 font-bold text-gray-950">{item.plantName}</td>
                        <td className="py-2.5 font-mono text-gray-500">{item.containerSize}</td>
                        <td className="py-2.5 text-center font-mono font-black text-gray-950">
                          {item.totalQty}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 border-b-2 border-gray-300 font-bold text-gray-950 text-xs font-mono">
                      <td className="py-3 px-2 font-sans font-black" colSpan={2}>
                        {selectedBOLType === 'consolidated' ? 'GRAND TOTAL CARGO' : 'SHIPMENT TOTAL CARGO'}
                      </td>
                      <td className="py-3 text-center">{totalPlants}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Special Instructions */}
              <div className="py-6 border-b border-gray-300 text-xs">
                <h3 className="text-xs font-bold font-mono uppercase text-gray-500 tracking-wider mb-2">
                  Special Transport & Loading Instructions
                </h3>
                <p className="bg-slate-50 border border-gray-200 rounded-lg p-3 text-gray-700 leading-relaxed font-sans italic whitespace-pre-wrap">
                  {specialInstructions}
                </p>
              </div>

              {/* Regulatory certification statement */}
              <div className="py-5 text-[9px] text-gray-500 leading-normal border-b border-gray-300">
                <p className="font-bold uppercase mb-1">Shipper Certification:</p>
                <p>
                  This is to certify that the above-named materials are properly classified, packaged, marked, and labeled, and are in proper condition for transportation according to the applicable regulations of the Department of Transportation.
                </p>
                <p className="mt-2">
                  <span className="font-bold">Carrier Acknowledgment:</span> Carrier hereby acknowledges receipt of the packages/plants listed hereon in good apparent condition, except as noted. Carrier certifies that emergency response information was provided with this shipment.
                </p>
              </div>

              {/* Signature Blocks */}
              <div className="pt-6 grid grid-cols-1 md:grid-cols-2 gap-8 text-[11px] font-mono">
                <div className="space-y-6">
                  <div>
                    <p className="text-gray-400 font-bold uppercase text-[9px] tracking-wider mb-1">
                      Shipper Representative ({nurseryName})
                    </p>
                    <div className="flex items-end pt-4 border-b border-gray-300">
                      <span className="text-[10px] text-gray-400 mr-2 shrink-0">Signature:</span>
                      <span className="flex-1"></span>
                    </div>
                    <div className="grid grid-cols-2 gap-4 mt-2">
                      <div className="flex items-end border-b border-gray-300">
                        <span className="text-[10px] text-gray-400 mr-2 shrink-0">Printed Name:</span>
                        <span className="flex-1"></span>
                      </div>
                      <div className="flex items-end border-b border-gray-300">
                        <span className="text-[10px] text-gray-400 mr-2 shrink-0">Date:</span>
                        <span className="flex-1"></span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <p className="text-gray-400 font-bold uppercase text-[9px] tracking-wider mb-1">
                      Carrier / Transport Driver Certificate
                    </p>
                    <div className="flex items-end pt-4 border-b border-gray-300">
                      <span className="text-[10px] text-gray-400 mr-2 shrink-0">Driver Sign:</span>
                      <span className="flex-1"></span>
                    </div>
                    <div className="grid grid-cols-2 gap-4 mt-2">
                      <div className="flex items-end border-b border-gray-300">
                        <span className="text-[10px] text-gray-400 mr-2 shrink-0">Printed Name:</span>
                        <span className="flex-1 font-sans font-bold text-xs pl-1">{driverName}</span>
                      </div>
                      <div className="flex items-end border-b border-gray-300">
                        <span className="text-[10px] text-gray-400 mr-2 shrink-0">Date:</span>
                        <span className="flex-1"></span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-6 bg-slate-50 border border-gray-250 p-4 rounded-lg">
                  <p className="text-gray-500 font-bold uppercase text-[9px] tracking-wider mb-1">
                    Consignee / Customer Stop Deliveries Receipt
                  </p>
                  <p className="text-[10px] text-gray-500 font-sans leading-normal mb-3">
                    {selectedBOLType === 'consolidated'
                      ? "Each stop consignee must sign below to certify that all items scheduled in the cargo breakdown have been fully delivered in satisfactory condition."
                      : "The customer consignee representative must sign below to certify that all items scheduled in this individual cargo breakdown have been fully delivered in satisfactory condition."
                    }
                  </p>
                  
                  <div className="space-y-4">
                    {currentBOLOrders.map((order, index) => (
                      <div key={order.id} className="pt-2 border-t border-gray-200 first:border-none first:pt-0">
                        <p className="text-[10px] font-black text-gray-900 font-sans">
                          {selectedBOLType === 'consolidated' ? `STOP ${index + 1}: ` : ''}{order.customerName} (Order #{order.orderNumber})
                        </p>
                        <div className="flex items-end pt-3 border-b border-gray-300">
                          <span className="text-[9px] text-gray-400 mr-2 shrink-0">Received By:</span>
                          <span className="flex-1"></span>
                        </div>
                        <div className="flex items-end pt-2 border-b border-gray-300">
                          <span className="text-[9px] text-gray-400 mr-2 shrink-0">Date / Time:</span>
                          <span className="flex-1"></span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Page Number / Footer */}
              <div className="pt-10 text-center text-[9px] text-gray-400 font-mono">
                {nurseryName} • {selectedBOLType === 'consolidated' ? 'Consolidated Carrier Document' : `Individual Shipment: Order #${singleOrder?.orderNumber}`} • Page 1 of 1
              </div>

            </div>
          </div>

        </div>

      </div>

    </div>,
    document.body
  );
};
