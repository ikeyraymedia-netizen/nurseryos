/**
 * Generates docs/NurseryOS-Getting-Started.pdf — client onboarding guide.
 * Run: node scripts/generate-onboarding-pdf.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { jsPDF } = require('jspdf');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '..', 'docs', 'NurseryOS-Getting-Started.pdf');

const C = {
  teal: [14, 116, 144], // ink-700
  tealDark: [21, 94, 117], // ink-800
  slate: [15, 23, 42], // ink-950
  muted: [100, 116, 139],
  line: [226, 232, 240],
  soft: [236, 254, 255], // ink-50
  coral: [255, 107, 74], // coral-500
  white: [255, 255, 255],
  card: [248, 250, 252]
};

function rgb(doc, [r, g, b]) {
  doc.setTextColor(r, g, b);
}
function fill(doc, [r, g, b]) {
  doc.setFillColor(r, g, b);
}
function stroke(doc, [r, g, b]) {
  doc.setDrawColor(r, g, b);
}

function pageFooter(doc, page, total) {
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  stroke(doc, C.line);
  doc.setLineWidth(0.6);
  doc.line(40, h - 36, w - 40, h - 36);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  rgb(doc, C.muted);
  doc.text('nurseryos.app  ·  owner@nurseryos.app', 40, h - 22);
  doc.text(`${page} / ${total}`, w - 40, h - 22, { align: 'right' });
}

function sectionTitle(doc, y, title) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  rgb(doc, C.teal);
  doc.text(title, 40, y);
  stroke(doc, C.teal);
  doc.setLineWidth(1.5);
  doc.line(40, y + 4, 40 + doc.getTextWidth(title), y + 4);
  return y + 18;
}

function body(doc, y, text, opts = {}) {
  const maxW = opts.maxW ?? 532;
  doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
  doc.setFontSize(opts.size ?? 10);
  rgb(doc, opts.color ?? C.slate);
  const lines = doc.splitTextToSize(text, maxW);
  doc.text(lines, opts.x ?? 40, y);
  return y + lines.length * (opts.lh ?? 13) + (opts.after ?? 6);
}

function bullet(doc, y, text) {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  rgb(doc, C.coral);
  doc.text('•', 44, y);
  doc.setFont('helvetica', 'normal');
  rgb(doc, C.slate);
  const lines = doc.splitTextToSize(text, 510);
  doc.text(lines, 56, y);
  return y + lines.length * 13 + 4;
}

function stepCard(doc, y, num, title, lines) {
  const w = doc.internal.pageSize.getWidth();
  const textLines = [];
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  for (const line of lines) {
    textLines.push(...doc.splitTextToSize(line, 470));
  }
  const boxH = 28 + textLines.length * 12 + 10;
  fill(doc, C.card);
  stroke(doc, C.line);
  doc.setLineWidth(0.6);
  doc.roundedRect(40, y, w - 80, boxH, 6, 6, 'FD');

  fill(doc, C.teal);
  doc.circle(58, y + 16, 9, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  rgb(doc, C.white);
  doc.text(String(num), 58, y + 19, { align: 'center' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  rgb(doc, C.slate);
  doc.text(title, 76, y + 19);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  rgb(doc, C.muted);
  let ty = y + 34;
  for (const line of textLines) {
    doc.text(line, 76, ty);
    ty += 12;
  }
  return y + boxH + 10;
}

function drawCover(doc) {
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();

  fill(doc, C.slate);
  doc.rect(0, 0, w, h, 'F');

  // Accent bar
  fill(doc, C.teal);
  doc.rect(0, 0, 14, h, 'F');
  fill(doc, C.coral);
  doc.rect(14, 0, 4, h, 'F');

  // Soft panel
  fill(doc, [30, 41, 59]);
  doc.roundedRect(48, 120, w - 96, 320, 12, 12, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  rgb(doc, C.coral);
  doc.text('CLIENT GUIDE', 72, 160);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(36);
  rgb(doc, C.white);
  doc.text('NurseryOS', 72, 210);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  rgb(doc, [165, 243, 252]);
  doc.text('Getting started for your nursery', 72, 236);

  doc.setFontSize(10.5);
  rgb(doc, [148, 163, 184]);
  const blurb = doc.splitTextToSize(
    'Inventory, trucks, invoices, and vendor payments — one place for the yard and the office. Works on phone, tablet, or computer.',
    w - 180
  );
  doc.text(blurb, 72, 270);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  rgb(doc, C.teal);
  doc.text('nurseryos.app', 72, 340);
  doc.setFont('helvetica', 'normal');
  rgb(doc, [148, 163, 184]);
  doc.text('Questions?  owner@nurseryos.app', 72, 358);

  doc.setFontSize(8);
  rgb(doc, [100, 116, 139]);
  doc.text('Keep this handy while you set up Team, Stripe, and Checkbook.', 72, h - 48);
}

function drawChecklistPage(doc) {
  let y = 52;
  y = sectionTitle(doc, y, 'Quick setup checklist');
  y = body(
    doc,
    y,
    'Use this list when onboarding. Check items off as you go — most nurseries finish core setup in one sitting once bank verify is done.'
  );
  y += 6;

  const items = [
    'Sign in at nurseryos.app (or accept your invite link)',
    'Confirm nursery name and invite your team (Team)',
    'Add or import plant inventory (with photos + ready dates)',
    'Export an availability list and share with a customer',
    'Create a truck and load a sample order',
    'Create a test invoice (or small live invoice)',
    'Connect Stripe (owner/admin) and finish Stripe’s form',
    'Collect one real customer card payment',
    'Create a Checkbook account and verify your bank (microdeposits may take 1–3 business days)',
    'Paste Checkbook production keys in Team',
    'Copy the webhook URL from Team into Checkbook Developer settings',
    'Pay one small vendor bill via ACH to confirm bill pay'
  ];

  for (const item of items) {
    // checkbox
    stroke(doc, C.teal);
    doc.setLineWidth(1);
    doc.roundedRect(44, y - 7, 10, 10, 1.5, 1.5, 'S');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    rgb(doc, C.slate);
    const lines = doc.splitTextToSize(item, 500);
    doc.text(lines, 62, y);
    y += Math.max(18, lines.length * 13 + 6);
  }

  y += 8;
  fill(doc, C.soft);
  stroke(doc, C.teal);
  doc.setLineWidth(0.8);
  doc.roundedRect(40, y, 532, 56, 8, 8, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  rgb(doc, C.tealDark);
  doc.text('Tip', 56, y + 20);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  rgb(doc, C.slate);
  doc.text(
    'Stripe and Checkbook can be set up in either order. You can invoice customers\nbefore vendor ACH is ready — Checkbook only blocks paying vendor bills.',
    56,
    y + 36
  );
}

function main() {
  const doc = new jsPDF('p', 'pt', 'letter');
  const totalPages = 4;

  // ——— Page 1: Cover ———
  drawCover(doc);

  // ——— Page 2: Welcome + account ———
  doc.addPage();
  let y = 52;
  y = sectionTitle(doc, y, 'Welcome to NurseryOS');
  y = body(
    doc,
    y,
    'NurseryOS keeps live inventory, loading trucks, customer invoices, and vendor bill pay in one bilingual workspace (English · Español). This guide covers first-week setup for owners and office staff.'
  );
  y += 4;
  y = sectionTitle(doc, y, '1. Sign in & invite your team');
  y = stepCard(doc, y, 1, 'Open NurseryOS', [
    'Go to https://nurseryos.app on any phone, tablet, or computer.',
    'Sign in with the account you were invited with, or complete signup if you requested access.'
  ]);
  y = stepCard(doc, y, 2, 'Invite the crew (Team)', [
    'Open Team from the header. Owner/admin can invite people by email.',
    'Assign roles: owner/admin (settings & payments), office/sales (invoices & customers),',
    'field/loader (trucks & inventory as permitted).'
  ]);
  y = stepCard(doc, y, 3, 'Language', [
    'Anyone can switch the whole app between English and Spanish from their profile / language control.',
    'Yard and office can each work in the language they prefer.'
  ]);

  y += 4;
  y = sectionTitle(doc, y, '2. Inventory & availability');
  y = bullet(doc, y, 'Add plants manually, or upload CSV / Excel / PDF catalogs.');
  y = bullet(doc, y, 'Set quantity, photos, planted date, and ready date on each plant.');
  y = bullet(doc, y, 'Export Availability (Excel or PDF) to send customers what’s in stock — Ready Date shows on the list.');
  y = bullet(doc, y, 'Log sprays, fertilizers, and cut-backs so the yard stays in sync with the office.');

  // ——— Page 3: Orders, invoices, Stripe ———
  doc.addPage();
  y = 52;
  y = sectionTitle(doc, y, '3. Orders & trucks');
  y = bullet(doc, y, 'Upload or enter customer plant orders.');
  y = bullet(doc, y, 'Build a truck, set a loading date, and assign orders.');
  y = bullet(doc, y, 'Loaders check off plants on their phone; inventory updates live.');
  y = bullet(doc, y, 'Print or share a Bill of Lading when the truck rolls.');
  y += 8;

  y = sectionTitle(doc, y, '4. Invoices & getting paid (Stripe)');
  y = body(
    doc,
    y,
    'You do not need a Stripe account beforehand. NurseryOS creates a connected Stripe Express account when you click Connect.'
  );
  y = stepCard(doc, y, 1, 'Connect Stripe', [
    'Team → Stripe Connect → Connect Stripe (owner or admin only).',
    'Stripe opens a secure form: business details, bank account, and identity.',
    'When finished, return to NurseryOS — you should see ready to collect payments.'
  ]);
  y = stepCard(doc, y, 2, 'Send a pay link', [
    'Open an invoice → create a Stripe pay link and send it to your customer.',
    'They pay by card (or ACH when enabled). Funds go to your nursery’s Stripe account.',
    'Start with a small invoice to confirm everything end-to-end.'
  ]);
  y += 4;
  fill(doc, [255, 247, 237]);
  stroke(doc, [253, 186, 116]);
  doc.setLineWidth(0.8);
  doc.roundedRect(40, y, 532, 48, 8, 8, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  rgb(doc, [154, 52, 18]);
  doc.text('Note', 56, y + 18);
  doc.setFont('helvetica', 'normal');
  doc.text(
    'Use real business EIN / SSN on Stripe’s live form. Test IDs only work in sandbox and often fail in the hosted UI.',
    56,
    y + 34
  );

  // ——— Page 4: Checkbook + checklist ———
  doc.addPage();
  y = 52;
  y = sectionTitle(doc, y, '5. Paying vendors (Checkbook ACH)');
  y = body(
    doc,
    y,
    'Unlike Stripe, you create a Checkbook account first, then paste API keys into NurseryOS.'
  );
  y = stepCard(doc, y, 1, 'Create & verify Checkbook', [
    'Sign up at checkbook.io and add your business bank account.',
    'If Checkbook uses microdeposits, expect 1–3 business days before you can confirm amounts.',
    'After the bank is verified, open Settings → Developer.'
  ]);
  y = stepCard(doc, y, 2, 'Connect in NurseryOS', [
    'Team → Vendor ACH Bill Pay (Checkbook).',
    'Choose Production, paste Publishable key + Secret key, then Connect.',
    'Copy the webhook URL shown in Team (includes your nursery id).'
  ]);
  y = stepCard(doc, y, 3, 'Webhook in Checkbook', [
    'In Checkbook Developer settings, paste that exact webhook URL.',
    'Example shape: https://nurseryos.app/api/checkbook/webhook?tenantId=YOUR_ID',
    'Optional: paste the webhook signing key back into NurseryOS.',
    'Then pay a small vendor bill from Purchasing to confirm ACH.'
  ]);
  y += 6;
  y = sectionTitle(doc, y, 'Need help?');
  y = body(doc, y, 'Email owner@nurseryos.app — we’re happy to walk through setup on a call with your first invoice and first vendor payment.');

  // ——— Extra checklist page ———
  doc.addPage();
  drawChecklistPage(doc);

  const pages = doc.getNumberOfPages();
  for (let i = 2; i <= pages; i++) {
    doc.setPage(i);
    pageFooter(doc, i - 1, pages - 1);
  }

  const buf = Buffer.from(doc.output('arraybuffer'));
  fs.writeFileSync(outPath, buf);
  console.log('Wrote', outPath, `(${buf.length} bytes, ${pages} pages)`);
}

main();
