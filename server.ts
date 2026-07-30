import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { registerQuickbooksRoutes, isQuickbooksConfigured } from './server/quickbooks';
import {
  registerStripeRoutes,
  registerStripeWebhookRoute,
  isStripeConfigured
} from './server/stripe';
import {
  registerCheckbookRoutes,
  registerCheckbookWebhookRoute
} from './server/checkbook';
import { registerEmailRoutes } from './server/email';
import { registerPlatformRoutes } from './server/platform';
import {
  isSpreadsheetInventoryUpload,
  parseInventorySpreadsheetBuffer
} from './server/inventoryParse';
import {
  decodeBase64Text,
  isPlainTextMime,
  parseOrderTextLocally,
  localParseLooksIncomplete
} from './server/orderTextParse';

dotenv.config();

const app = express();

// Stripe / Checkbook webhooks need the raw body for signature verification — before JSON parser.
registerStripeWebhookRoute(app);
registerCheckbookWebhookRoute(app);

// Increase payload limit to handle base64 PDFs and images
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = Number(process.env.PORT) || 3000;

registerQuickbooksRoutes(app);
registerStripeRoutes(app);
registerCheckbookRoutes(app);
registerEmailRoutes(app);
registerPlatformRoutes(app);

// Lazy initialize Google Gen AI
let aiClient: GoogleGenAI | null = null;
function getAiClient() {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured. Please define it in your secrets.');
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const GEMINI_REQUEST_TIMEOUT_MS = 55_000;
const INVENTORY_GEMINI_TIMEOUT_MS = 240_000;

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = GEMINI_REQUEST_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getApiStatusCode(error: any): number | null {
  const status = error?.status || error?.code || error?.error?.code;
  if (typeof status === 'number') return status;

  if (typeof error?.message === 'string') {
    try {
      const parsed = JSON.parse(error.message);
      const nested = parsed?.error?.code;
      if (typeof nested === 'number') return nested;
    } catch {
      // Not JSON; ignore.
    }
  }

  return null;
}

function isRetryableModelError(error: any): boolean {
  const status = getApiStatusCode(error);
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const msg = String(error?.message || '').toLowerCase();
  return (
    msg.includes('high demand') ||
    msg.includes('unavailable') ||
    msg.includes('rate limit') ||
    msg.includes('timed out') ||
    msg.includes('timeout')
  );
}

function isSkippableModelError(error: any): boolean {
  const status = getApiStatusCode(error);
  if (status === 404) return true;
  const msg = String(error?.message || '').toLowerCase();
  return (
    msg.includes('no longer available') ||
    msg.includes('not found') ||
    msg.includes('timed out') ||
    msg.includes('timeout')
  );
}

const PARSE_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash',
  // Legacy fallbacks for older API keys that still have 2.5 access
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash'
] as const;

function normalizeOrderMimeType(mimeType: string | undefined, fileName?: string): string {
  const raw = String(mimeType || '')
    .trim()
    .toLowerCase();
  if (raw === 'application/pdf' || raw === 'application/x-pdf' || raw === 'application/acrobat') {
    return 'application/pdf';
  }
  if (raw === 'image/jpg' || raw === 'image/pjpeg') return 'image/jpeg';
  if (raw === 'image/jpeg' || raw === 'image/png' || raw === 'image/webp' || raw === 'text/plain') {
    return raw;
  }
  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.txt')) return 'text/plain';
  return raw || 'application/pdf';
}

function getOrderParseSchema() {
  return {
    responseMimeType: 'application/json' as const,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        customerName: {
          type: Type.STRING,
          description: 'The name of the customer or business placing the order'
        },
        orderNumber: {
          type: Type.STRING,
          description: 'The order number, invoice number, or PO number'
        },
        items: {
          type: Type.ARRAY,
          description: 'A list of plant items extracted from the order',
          items: {
            type: Type.OBJECT,
            properties: {
              plantName: { type: Type.STRING, description: 'Clean scientific or common name of the plant' },
              containerSize: {
                type: Type.STRING,
                description: 'The standardized container size (e.g. #1, #3, #5, #7, #10, #15, #30, B&B, 4 inch, 6 inch, Tray, Other)'
              },
              quantity: { type: Type.INTEGER, description: 'Quantity ordered' },
              notes: { type: Type.STRING, description: 'Any special notes or specs for this item, if found' }
            },
            required: ['plantName', 'containerSize', 'quantity']
          }
        },
        plainText: {
          type: Type.STRING,
          description: 'A clean, highly readable plain-text visual checklist representation for loaders'
        }
      },
      required: ['customerName', 'orderNumber', 'items', 'plainText']
    }
  };
}

function getInventoryParseSchema() {
  return {
    responseMimeType: 'application/json' as const,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          description: 'Inventory plants extracted from the uploaded file',
          items: {
            type: Type.OBJECT,
            properties: {
              plantName: { type: Type.STRING },
              containerSize: { type: Type.STRING },
              quantityAvailable: { type: Type.INTEGER },
              weeksUntilReady: { type: Type.INTEGER },
              location: { type: Type.STRING },
              notes: { type: Type.STRING },
              cutBackAt: { type: Type.STRING },
              recentChemicals: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    chemicalName: { type: Type.STRING },
                    appliedAt: { type: Type.STRING },
                    notes: { type: Type.STRING }
                  },
                  required: ['chemicalName']
                }
              }
            },
            required: ['plantName', 'containerSize', 'quantityAvailable']
          }
        }
      },
      required: ['items']
    }
  };
}

async function generateOrderParseResponse(
  ai: GoogleGenAI,
  model: string,
  mimeType: string,
  cleanBase64: string,
  prompt: string,
  orderText?: string
) {
  const contents = orderText
    ? [`${prompt}\n\n--- PASTED ORDER TEXT ---\n${orderText}`]
    : [
        {
          inlineData: {
            mimeType,
            data: cleanBase64
          }
        },
        prompt
      ];

  return withTimeout(
    ai.models.generateContent({
      model,
      contents,
      config: getOrderParseSchema()
    }),
    `Order parse (${model})`
  );
}

async function parseOrderWithFallback(
  ai: GoogleGenAI,
  mimeType: string,
  cleanBase64: string,
  prompt: string,
  orderText?: string
) {
  let lastError: any = null;
  const maxAttemptsPerModel = 2;

  for (const model of PARSE_MODELS) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt += 1) {
      try {
        console.log(`Parsing order with ${model} (attempt ${attempt}/${maxAttemptsPerModel})...`);
        const response = await generateOrderParseResponse(
          ai,
          model,
          mimeType,
          cleanBase64,
          prompt,
          orderText
        );
        console.log(`Order parsed successfully with ${model}`);
        return response;
      } catch (err: any) {
        lastError = err;
        const retryable = isRetryableModelError(err);
        const skippable = isSkippableModelError(err);
        const hasMoreAttemptsOnModel = attempt < maxAttemptsPerModel;
        const hasMoreModels = model !== PARSE_MODELS[PARSE_MODELS.length - 1];

        if (!retryable && !skippable) {
          throw err;
        }

        if (skippable && hasMoreModels) {
          console.warn(`${model} is unavailable, trying fallback model...`);
          break;
        }

        if (hasMoreAttemptsOnModel) {
          const backoffMs = 800 * attempt + Math.floor(Math.random() * 300);
          console.warn(`${model} busy (attempt ${attempt}), retrying in ${backoffMs}ms...`);
          await sleep(backoffMs);
          continue;
        }

        if (hasMoreModels) {
          console.warn(`${model} unavailable after ${maxAttemptsPerModel} attempts, trying fallback model...`);
          break;
        }
      }
    }
  }

  throw lastError || new Error('All Gemini models failed to parse the order.');
}

async function generateInventoryParseResponse(
  ai: GoogleGenAI,
  model: string,
  mimeType: string,
  cleanBase64: string,
  prompt: string
) {
  return withTimeout(
    ai.models.generateContent({
      model,
      contents: [
        {
          inlineData: {
            mimeType,
            data: cleanBase64
          }
        },
        prompt
      ],
      config: getInventoryParseSchema()
    }),
    `Inventory parse (${model})`,
    INVENTORY_GEMINI_TIMEOUT_MS
  );
}

async function parseInventoryWithFallback(
  ai: GoogleGenAI,
  mimeType: string,
  cleanBase64: string,
  prompt: string
) {
  let lastError: any = null;
  const maxAttemptsPerModel = 1;

  for (const model of PARSE_MODELS) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt += 1) {
      try {
        console.log(`Parsing inventory with ${model} (attempt ${attempt}/${maxAttemptsPerModel})...`);
        const response = await generateInventoryParseResponse(ai, model, mimeType, cleanBase64, prompt);
        console.log(`Inventory parsed successfully with ${model}`);
        return response;
      } catch (err: any) {
        lastError = err;
        const retryable = isRetryableModelError(err);
        const skippable = isSkippableModelError(err);
        const hasMoreAttemptsOnModel = attempt < maxAttemptsPerModel;
        const hasMoreModels = model !== PARSE_MODELS[PARSE_MODELS.length - 1];

        if (!retryable && !skippable) {
          throw err;
        }

        if (skippable && hasMoreModels) {
          console.warn(`${model} is unavailable, trying fallback model...`);
          break;
        }

        if (hasMoreAttemptsOnModel) {
          const backoffMs = 800 * attempt + Math.floor(Math.random() * 300);
          console.warn(`${model} busy (attempt ${attempt}), retrying in ${backoffMs}ms...`);
          await sleep(backoffMs);
          continue;
        }

        if (hasMoreModels) {
          console.warn(`${model} unavailable after ${maxAttemptsPerModel} attempts, trying fallback model...`);
          break;
        }
      }
    }
  }

  throw lastError || new Error('All Gemini models failed to parse inventory.');
}

// API endpoint to parse the order
app.post('/api/parse-order', async (req, res) => {
  try {
    const { base64Data, mimeType, fileName, orderText: rawOrderText } = req.body;

    const providedText =
      typeof rawOrderText === 'string' && rawOrderText.trim() ? rawOrderText.trim() : '';
    const looksLikeText =
      Boolean(providedText) ||
      isPlainTextMime(mimeType) ||
      /\.txt$/i.test(String(fileName || ''));

    if (!providedText && !base64Data) {
      res.status(400).json({ error: 'Missing order text or file data.' });
      return;
    }

    // Pasted plain text: parse locally first so upload works even when Gemini is slow/down.
    // If local parse looks incomplete (e.g. one merged line), fall through to AI.
    let localFallback: ReturnType<typeof parseOrderTextLocally> = null;
    if (looksLikeText) {
      const textBody = providedText || (base64Data ? decodeBase64Text(base64Data) : '');
      const local = parseOrderTextLocally(textBody);
      localFallback = local;
      if (local && !localParseLooksIncomplete(textBody, local)) {
        console.log(`Parsed pasted order locally (${local.items.length} items).`);
        res.json(local);
        return;
      }
      if (local) {
        console.log(
          `Local paste parse looks incomplete (${local.items.length} items) — trying AI.`
        );
      }
    }

    if (!base64Data && !providedText) {
      res.status(400).json({ error: 'Missing base64Data or orderText.' });
      return;
    }

    const ai = getAiClient();

    // Clean up base64 prefix if present
    const cleanBase64 = base64Data ? String(base64Data).replace(/^data:.*?;base64,/, '') : '';
    const resolvedMime = normalizeOrderMimeType(mimeType, fileName);
    const orderTextForAi =
      providedText ||
      (looksLikeText && cleanBase64 ? decodeBase64Text(base64Data) : undefined);

    const prompt = `Analyze this plant order document (${fileName || 'document'}).
It is a customer plant order list/invoice from a nursery. Extract:
1. Customer Name (look for Bill To, Ship To, Client, or main header name).
2. Order or Invoice Number (look for invoice#, order#, PO#, etc. Use 'N/A' if not found).
3. Structured list of plant items. Standardize the container sizes to the closest match from these standard terms:
   - '#1' (for 1 gallon, 1g, #1 pot, No. 1)
   - '#3' (for 3 gallon, 3g, #3 pot, No. 3)
   - '#5' (for 5 gallon, 5g, #5 pot, No. 5)
   - '#7' (for 7 gallon, 7g, #7 pot, No. 7)
   - '#10' (for 10 gallon, 10g, #10 pot)
   - '#15' (for 15 gallon, 15g, #15 pot)
   - '#30' (for 30 gallon, 30g, #30 pot)
   - '#45' (for 45 gallon)
   - '#65' (for 65 gallon)
   - '#100' (for 100 gallon)
   - 'B&B' (for balled and burlapped, B&B trees, Caliper trees)
   - '4 inch' (for 4" pots)
   - '6 inch' (for 6" pots)
   - 'Tray' (for plant flats, plug trays, or groundcover trays)
   - 'Other' (if it doesn't fit any of the above, keep the size as reported)

4. Generate a beautifully formatted plain-text representation (plainText) of the order.
This text is meant for nursery workers loading trucks, so make it incredibly clear, bolding quantities and container sizes, listing plants in a neat checklist format with checkboxes [ ]. Exclude irrelevant invoice headers, tax calculations, or billing terms. Focus 100% on what plants need to be loaded!

Return your response in structured JSON format matching the schema provided.`;

    let response: any = null;
    response = await parseOrderWithFallback(
      ai,
      resolvedMime,
      cleanBase64,
      prompt,
      orderTextForAi
    );

    const responseText = response.text;
    if (!responseText) {
      throw new Error('Gemini model returned empty response.');
    }

    const cleanedJson = responseText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsedData: any;
    try {
      parsedData = JSON.parse(cleanedJson);
    } catch {
      throw new Error('AI returned invalid JSON. Please try uploading again.');
    }
    const aiItems = Array.isArray(parsedData?.items) ? parsedData.items : [];
    if (
      localFallback &&
      localFallback.items.length > aiItems.length
    ) {
      console.log(
        `AI returned ${aiItems.length} items; keeping stronger local parse (${localFallback.items.length}).`
      );
      res.json(localFallback);
      return;
    }
    res.json(parsedData);
  } catch (error: any) {
    console.error('Error parsing order with Gemini:', error);
    // Prefer any local paste parse over a hard failure.
    try {
      const raw =
        typeof req.body?.orderText === 'string' ? req.body.orderText : '';
      const local = raw.trim() ? parseOrderTextLocally(raw) : null;
      if (local && local.items.length > 0) {
        console.log(`Gemini failed; returning local paste parse (${local.items.length} items).`);
        res.json(local);
        return;
      }
    } catch {
      // ignore and continue with normal error response
    }
    const msg = String(error?.message || error || '');
    if (msg.toLowerCase().includes('gemini_api_key') || msg.toLowerCase().includes('not configured')) {
      res.status(500).json({
        error: 'GEMINI_API_KEY is missing on the server. Add it in Railway → Variables, then redeploy.',
        details: msg
      });
      return;
    }
    const statusCode = getApiStatusCode(error);
    if (statusCode === 429 || statusCode === 503) {
      res.status(503).json({
        error: 'AI service is temporarily busy. Please try again in a few seconds.',
        details: msg
      });
      return;
    }
    if (statusCode === 401 || statusCode === 403 || msg.toLowerCase().includes('api key')) {
      res.status(500).json({
        error: 'Gemini API key was rejected. Check GEMINI_API_KEY in Railway Variables.',
        details: msg
      });
      return;
    }
    res.status(500).json({
      error: 'Failed to process order document.',
      details: msg
    });
  }
});

// API endpoint to parse inventory files (PDF/image via AI; CSV/Excel parsed locally)
app.post('/api/parse-inventory', async (req, res) => {
  try {
    const { base64Data, mimeType, fileName } = req.body;
    if (!base64Data || !mimeType) {
      res.status(400).json({ error: 'Missing base64Data or mimeType.' });
      return;
    }

    const cleanBase64 = String(base64Data).replace(/^data:.*?;base64,/, '');

    // Spreadsheets are not supported by Gemini mime types — parse them directly.
    if (isSpreadsheetInventoryUpload(String(mimeType), fileName)) {
      const buffer = Buffer.from(cleanBase64, 'base64');
      const items = await parseInventorySpreadsheetBuffer(buffer, fileName);
      if (items.length === 0) {
        res.status(400).json({
          error:
            'No plant rows found in that spreadsheet. For price catalogs, size headers (#1, #3, 4") and priced plant rows are required.'
        });
        return;
      }
      res.json({ items });
      return;
    }

    const ai = getAiClient();
    const prompt = `Analyze this nursery inventory source file (${fileName || 'inventory file'}).
Extract a clean plant inventory list where each item includes:
1) plantName
2) containerSize (standardized if possible: #1, #3, #5, #7, #10, #15, #30, #45, #65, #100, B&B, 4 inch, 6 inch, Tray, Other)
3) quantityAvailable (integer, default 0 if unknown)
4) weeksUntilReady (integer if shown, otherwise omit)
5) location (if present)
6) notes (if relevant)
7) cutBackAt date if clearly mentioned, otherwise omit
8) recentChemicals array if sprays are listed (chemicalName, appliedAt if available, notes if available)

Return strict JSON matching schema. Do not include narrative text.`;

    const response = await parseInventoryWithFallback(ai, mimeType, cleanBase64, prompt);
    const responseText = response.text;
    if (!responseText) {
      throw new Error('Gemini model returned empty response.');
    }

    const parsedData = JSON.parse(responseText);
    const items = Array.isArray(parsedData?.items) ? parsedData.items : [];
    res.json({ items });
  } catch (error: any) {
    console.error('Error parsing inventory with Gemini:', error);
    const statusCode = getApiStatusCode(error);
    const isTimeout = String(error?.message || '').includes('timed out');
    if (isTimeout) {
      res.status(504).json({
        error: 'AI analysis took too long. Large PDFs can take several minutes — please try again and wait, or export a shorter page range.',
        details: error.message || error
      });
      return;
    }
    if (statusCode === 429 || statusCode === 503) {
      res.status(503).json({
        error: 'AI service is temporarily busy. Please try inventory import again in a few seconds.',
        details: error.message || error
      });
      return;
    }
    res.status(500).json({
      error: 'Failed to process inventory file.',
      details: error.message || error
    });
  }
});

function getVendorInvoiceParseSchema() {
  return {
    responseMimeType: 'application/json' as const,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        vendorName: {
          type: Type.STRING,
          description: 'Wholesale grower / vendor who issued this invoice (From / Sold By / Remit To)'
        },
        vendorInvoiceNumber: {
          type: Type.STRING,
          description: 'Vendor invoice number if present, otherwise N/A'
        },
        billDate: {
          type: Type.STRING,
          description: 'Invoice date as YYYY-MM-DD if found, otherwise empty string'
        },
        dueDate: {
          type: Type.STRING,
          description: 'Due date as YYYY-MM-DD if found, otherwise empty string'
        },
        freightCharge: {
          type: Type.NUMBER,
          description:
            'Document-level freight / shipping / delivery charge if listed separately from line items, else 0'
        },
        notes: {
          type: Type.STRING,
          description: 'Payment terms, PO reference, or other useful bill notes'
        },
        items: {
          type: Type.ARRAY,
          description:
            'All purchase lines: plants, supplies, chemicals, containers, tools, freight rows, etc.',
          items: {
            type: Type.OBJECT,
            properties: {
              plantName: {
                type: Type.STRING,
                description: 'Plant name or supply / product description'
              },
              containerSize: {
                type: Type.STRING,
                description:
                  'For plants: standardized size (#1, #3, #5, #7, #10, #15, #30, #45, #65, #100, B&B, 4 inch, 6 inch, Tray, Other). For non-plants use empty string or Other.'
              },
              quantity: { type: Type.INTEGER, description: 'Quantity billed' },
              unitCost: {
                type: Type.NUMBER,
                description: 'Unit price / cost each (not line total)'
              },
              category: {
                type: Type.STRING,
                description:
                  'Spend category label. Prefer one of: Plants, Soil / media, Containers / trays, Chemicals, Fertilizer, Freight, Fuel, Tools / equipment, General supplies, Other. Or a short custom label if none fit.'
              },
              notes: { type: Type.STRING, description: 'Line notes or grade/spec if present' }
            },
            required: ['plantName', 'containerSize', 'quantity', 'unitCost', 'category']
          }
        }
      },
      required: ['vendorName', 'vendorInvoiceNumber', 'items', 'freightCharge']
    }
  };
}

async function generateVendorInvoiceParseResponse(
  ai: GoogleGenAI,
  model: string,
  mimeType: string,
  cleanBase64: string,
  prompt: string,
  invoiceText?: string
) {
  const contents = invoiceText
    ? [`${prompt}\n\n--- PASTED VENDOR INVOICE TEXT ---\n${invoiceText}`]
    : [
        {
          inlineData: {
            mimeType,
            data: cleanBase64
          }
        },
        prompt
      ];

  return withTimeout(
    ai.models.generateContent({
      model,
      contents,
      config: getVendorInvoiceParseSchema()
    }),
    `Vendor invoice parse (${model})`
  );
}

async function parseVendorInvoiceWithFallback(
  ai: GoogleGenAI,
  mimeType: string,
  cleanBase64: string,
  prompt: string,
  invoiceText?: string
) {
  let lastError: any = null;
  const maxAttemptsPerModel = 2;

  for (const model of PARSE_MODELS) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt += 1) {
      try {
        console.log(
          `Parsing vendor invoice with ${model} (attempt ${attempt}/${maxAttemptsPerModel})...`
        );
        const response = await generateVendorInvoiceParseResponse(
          ai,
          model,
          mimeType,
          cleanBase64,
          prompt,
          invoiceText
        );
        console.log(`Vendor invoice parsed successfully with ${model}`);
        return response;
      } catch (err: any) {
        lastError = err;
        const retryable = isRetryableModelError(err);
        const skippable = isSkippableModelError(err);
        const hasMoreAttemptsOnModel = attempt < maxAttemptsPerModel;
        const hasMoreModels = model !== PARSE_MODELS[PARSE_MODELS.length - 1];

        if (!retryable && !skippable) {
          throw err;
        }

        if (skippable && hasMoreModels) {
          console.warn(`${model} is unavailable, trying fallback model...`);
          break;
        }

        if (hasMoreAttemptsOnModel) {
          const backoffMs = 800 * attempt + Math.floor(Math.random() * 300);
          console.warn(`${model} busy (attempt ${attempt}), retrying in ${backoffMs}ms...`);
          await sleep(backoffMs);
          continue;
        }

        if (hasMoreModels) {
          console.warn(
            `${model} unavailable after ${maxAttemptsPerModel} attempts, trying fallback model...`
          );
          break;
        }
      }
    }
  }

  throw lastError || new Error('All Gemini models failed to parse the vendor invoice.');
}

/** Parse a vendor (accounts-payable) invoice from photo, PDF, or pasted text. */
app.post('/api/parse-vendor-invoice', async (req, res) => {
  try {
    const { base64Data, mimeType, fileName, invoiceText: rawInvoiceText } = req.body;

    const providedText =
      typeof rawInvoiceText === 'string' && rawInvoiceText.trim()
        ? rawInvoiceText.trim()
        : '';
    const looksLikeText =
      Boolean(providedText) ||
      isPlainTextMime(mimeType) ||
      /\.txt$/i.test(String(fileName || ''));

    if (!providedText && !base64Data) {
      res.status(400).json({ error: 'Missing invoice text or file data.' });
      return;
    }

    const ai = getAiClient();
    const cleanBase64 = base64Data ? String(base64Data).replace(/^data:.*?;base64,/, '') : '';
    const resolvedMime = normalizeOrderMimeType(mimeType, fileName);
    const invoiceTextForAi =
      providedText ||
      (looksLikeText && cleanBase64 ? decodeBase64Text(base64Data) : undefined);

    const prompt = `Analyze this vendor invoice / packing list / purchase receipt (${fileName || 'document'}).
This is an ACCOUNTS-PAYABLE purchase FROM a vendor TO our nursery (we are the buyer).
It may include plants, soil, pots, chemicals, fertilizer, tools, freight, or mixed nursery supplies.
It is NOT a customer sales order.

Extract:
1. Vendor Name — the seller (From, Sold By, Remit To, store/letterhead). Not the Bill-To if that is us.
2. Vendor Invoice Number (Invoice #, Inv #, receipt #). Use "N/A" if missing.
3. billDate and dueDate as YYYY-MM-DD when clearly shown; otherwise empty string.
4. Do NOT put freight in a separate freightCharge field — if shipping/freight appears, add it as a normal line item with category Freight (quantity 1, unitCost = freight amount). Set freightCharge to 0.
5. notes — payment terms, our PO #, or short useful context.
6. ALL purchase line items (plants AND supplies AND freight rows):
   - plantName: plant name OR supply/product description (use "Freight" for freight lines)
   - containerSize: for plants use closest of #1, #3, #5, #7, #10, #15, #30, #45, #65, #100, B&B, 4 inch, 6 inch, Tray, Other; for non-plants use "" or Other
   - quantity (integer; use 1 if a lump sum with no qty)
   - unitCost (price EACH — if only a line total is shown, divide by quantity)
   - category: prefer Plants, Soil / media, Containers / trays, Chemicals, Fertilizer, Freight, Fuel, Tools / equipment, General supplies, or Other. If none fit, invent a short clear custom label (e.g. "Irrigation", "Packaging").
   - notes for grade/spec if present

Ignore sales tax unless it is the only total available.
Return structured JSON matching the schema.`;

    const response = await parseVendorInvoiceWithFallback(
      ai,
      resolvedMime,
      cleanBase64,
      prompt,
      invoiceTextForAi
    );

    const responseText = response.text;
    if (!responseText) {
      throw new Error('Gemini model returned empty response.');
    }

    const cleanedJson = responseText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsedData: any;
    try {
      parsedData = JSON.parse(cleanedJson);
    } catch {
      throw new Error('AI returned invalid JSON. Please try uploading again.');
    }
    res.json(parsedData);
  } catch (error: any) {
    console.error('Error parsing vendor invoice with Gemini:', error);
    const msg = String(error?.message || error || '');
    if (msg.toLowerCase().includes('gemini_api_key') || msg.toLowerCase().includes('not configured')) {
      res.status(500).json({
        error: 'GEMINI_API_KEY is missing on the server. Add it in Railway → Variables, then redeploy.',
        details: msg
      });
      return;
    }
    const statusCode = getApiStatusCode(error);
    if (statusCode === 429 || statusCode === 503) {
      res.status(503).json({
        error: 'AI service is temporarily busy. Please try again in a few seconds.',
        details: msg
      });
      return;
    }
    if (statusCode === 401 || statusCode === 403 || msg.toLowerCase().includes('api key')) {
      res.status(500).json({
        error: 'Gemini API key was rejected. Check GEMINI_API_KEY in Railway Variables.',
        details: msg
      });
      return;
    }
    res.status(500).json({
      error: 'Failed to process vendor invoice.',
      details: msg
    });
  }
});

// Check server status & API key configuration
app.get('/api/config-status', (req, res) => {
  res.json({
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    hasQuickbooks: isQuickbooksConfigured(),
    hasStripe: isStripeConfigured(),
    checkbookConnectVersion: 4
  });
});

app.post('/api/run-report', async (req, res) => {
  try {
    const { question, nurseryName, data } = req.body || {};
    if (!question || typeof question !== 'string' || !question.trim()) {
      res.status(400).json({ error: 'Missing report question.' });
      return;
    }
    if (!data || typeof data !== 'object') {
      res.status(400).json({ error: 'Missing nursery data snapshot.' });
      return;
    }

    const ai = getAiClient();
    const nursery = typeof nurseryName === 'string' && nurseryName.trim() ? nurseryName.trim() : 'Nursery';
    const snapshot = JSON.stringify(data);

    const prompt = `You are NurseryOS, an operations and sales analyst for a wholesale nursery named "${nursery}".

The user asked for this report:
"""
${question.trim()}
"""

Use ONLY the JSON nursery data below. Do not invent plants, customers, invoices, or dollar amounts. If data is missing, say so clearly.

Sales rules (important):
- Saved invoices (data.sales, data.invoices, summary.invoiceSalesTotal) are the source of truth for SALES.
- Estimates are quotes only — do NOT count them as sales unless the user explicitly asks about estimates.
- If there are zero invoices, say that no invoices have been saved yet and remind them: open an order → Create Invoice → Save to Customer.
- For "this month" / "sales this month" / current-month questions, use data.sales.thisMonth.salesTotal and data.sales.thisMonth.invoiceCount EXACTLY. Do not recompute from scratch.
- For "last month", use data.sales.lastMonth. For other months, use data.sales.byMonth.
- Prefer the pre-aggregated data.sales.byCustomer, data.sales.byMonth, and data.sales.topPlantsByRevenue when answering sales questions.
- Use invoice grandTotal for sales dollars unless asked for subtotal-only.
- If thisMonth.salesTotal is 0 but invoiceSalesTotal > 0, say sales this month are $0 and also mention all-time invoice sales + which months have sales in data.sales.byMonth.

Write a clear, practical report for nursery owners and managers:
- Start with a short title line
- Use plain text (no markdown code fences)
- Prefer short sections, bullet lists, and totals with $ amounts when relevant
- Call out risks, shortages, unfinished loads, and follow-ups when relevant
- Keep it concise but useful

NURSERY DATA JSON:
${snapshot}`;

    let lastError: any = null;
    let reportText = '';

    for (const model of PARSE_MODELS) {
      try {
        console.log(`Running report with ${model}...`);
        const response = await withTimeout(
          ai.models.generateContent({
            model,
            contents: prompt
          }),
          `Report (${model})`,
          GEMINI_REQUEST_TIMEOUT_MS
        );
        reportText = (response.text || '').trim();
        if (reportText) break;
        throw new Error('Gemini returned an empty report.');
      } catch (err: any) {
        lastError = err;
        if (isSkippableModelError(err)) {
          console.warn(`${model} unavailable for reports, trying fallback...`);
          continue;
        }
        if (isRetryableModelError(err)) {
          console.warn(`${model} busy for reports, trying fallback...`);
          continue;
        }
        throw err;
      }
    }

    if (!reportText) {
      throw lastError || new Error('Failed to generate report.');
    }

    res.json({ report: reportText });
  } catch (error: any) {
    console.error('Error running report with Gemini:', error);
    const msg = String(error?.message || error || '');
    if (msg.toLowerCase().includes('gemini_api_key') || msg.toLowerCase().includes('not configured')) {
      res.status(500).json({
        error: 'GEMINI_API_KEY is missing on the server. Add it in Railway → Variables, then redeploy.',
        details: msg
      });
      return;
    }
    const statusCode = getApiStatusCode(error);
    if (statusCode === 429 || statusCode === 503) {
      res.status(503).json({
        error: 'AI service is temporarily busy. Please try again in a few seconds.',
        details: msg
      });
      return;
    }
    res.status(500).json({
      error: 'Failed to run report.',
      details: msg
    });
  }
});

type PromoFormat = 'email' | 'social' | 'sms';
type PromoAudience = 'wholesale' | 'retail' | 'ready';

async function fetchImageAsInlineData(
  photoUrl: string
): Promise<{ mimeType: string; data: string } | null> {
  try {
    const url = String(photoUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const contentType = String(resp.headers.get('content-type') || 'image/jpeg')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const mimeType =
      contentType === 'image/png' || contentType === 'image/webp' || contentType === 'image/jpeg'
        ? contentType
        : 'image/jpeg';
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 100 || buf.length > 8 * 1024 * 1024) return null;
    return { mimeType, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

app.post('/api/generate-plant-promo', async (req, res) => {
  try {
    const {
      plantName,
      containerSize,
      quantityAvailable,
      category,
      listPrice,
      notes,
      photoUrl,
      nurseryName,
      format,
      audience,
      locale
    } = req.body || {};

    const name = typeof plantName === 'string' ? plantName.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'Missing plant name.' });
      return;
    }

    const fmt: PromoFormat =
      format === 'email' || format === 'sms' || format === 'social' ? format : 'social';
    const aud: PromoAudience =
      audience === 'retail' || audience === 'ready' || audience === 'wholesale'
        ? audience
        : 'wholesale';
    const lang = locale === 'es' ? 'es' : 'en';
    const nursery =
      typeof nurseryName === 'string' && nurseryName.trim() ? nurseryName.trim() : 'our nursery';

    const facts = [
      `Plant: ${name}`,
      containerSize ? `Container size: ${containerSize}` : null,
      quantityAvailable != null && quantityAvailable !== ''
        ? `Quantity available: ${quantityAvailable}`
        : null,
      category ? `Category: ${category}` : null,
      listPrice != null && listPrice !== '' ? `List price: $${Number(listPrice).toFixed(2)}` : null,
      notes ? `Notes: ${String(notes).slice(0, 240)}` : null
    ]
      .filter(Boolean)
      .join('\n');

    const formatGuide =
      fmt === 'email'
        ? 'Write a short customer email: subject line + body (2–4 short paragraphs). Friendly wholesale nursery tone. Include a soft call to action to inquire or order.'
        : fmt === 'sms'
          ? 'Write a short SMS / text blast (under 280 characters). One hook + plant + size + call to action. No hashtags.'
          : 'Write an Instagram/Facebook caption (2–5 short lines) plus 5–10 relevant hashtags on the last line. Conversational, not corporate.';

    const audienceGuide =
      aud === 'retail'
        ? 'Audience: homeowners / retail garden customers.'
        : aud === 'ready'
          ? 'Audience: landscapers and buyers looking for material ready to load now.'
          : 'Audience: wholesale landscapers, garden centers, and contractors.';

    const languageGuide =
      lang === 'es'
        ? 'Write the entire response in Spanish (Mexico/US nursery Spanish is fine).'
        : 'Write the entire response in English.';

    const prompt = `You are a marketing assistant for "${nursery}", a plant nursery using NurseryOS.

${languageGuide}
${formatGuide}
${audienceGuide}

Use ONLY these plant facts (do not invent availability, prices, or botanical claims beyond what's given):
${facts}

${photoUrl ? 'A plant photo is attached when available — reference the look only if the image is present.' : 'No photo was provided.'}

Return JSON only with this shape:
{
  "headline": "short headline or subject",
  "body": "main email body or social caption without hashtags",
  "hashtags": "optional space-separated hashtags for social, else empty string",
  "imageTip": "one short tip for how to use the photo in the post/email"
}`;

    const ai = getAiClient();
    const imagePart = typeof photoUrl === 'string' ? await fetchImageAsInlineData(photoUrl) : null;

    const contents: any[] = [];
    if (imagePart) {
      contents.push({
        inlineData: {
          mimeType: imagePart.mimeType,
          data: imagePart.data
        }
      });
    }
    contents.push(prompt);

    let lastError: any = null;
    let parsed: {
      headline?: string;
      body?: string;
      hashtags?: string;
      imageTip?: string;
    } | null = null;

    for (const model of PARSE_MODELS) {
      try {
        console.log(`Generating plant promo with ${model}...`);
        const response = await withTimeout(
          ai.models.generateContent({
            model,
            contents,
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  headline: { type: Type.STRING },
                  body: { type: Type.STRING },
                  hashtags: { type: Type.STRING },
                  imageTip: { type: Type.STRING }
                },
                required: ['headline', 'body', 'hashtags', 'imageTip']
              }
            }
          }),
          `Plant promo (${model})`,
          GEMINI_REQUEST_TIMEOUT_MS
        );
        const text = (response.text || '').trim();
        if (!text) throw new Error('Empty promo response.');
        const cleaned = text
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim();
        parsed = JSON.parse(cleaned);
        if (parsed?.body) break;
        throw new Error('Promo JSON missing body.');
      } catch (err: any) {
        lastError = err;
        if (isSkippableModelError(err) || isRetryableModelError(err)) {
          console.warn(`${model} unavailable/busy for plant promo, trying fallback...`);
          continue;
        }
        throw err;
      }
    }

    if (!parsed?.body) {
      throw lastError || new Error('Failed to generate plant promo.');
    }

    res.json({
      headline: String(parsed.headline || '').trim(),
      body: String(parsed.body || '').trim(),
      hashtags: String(parsed.hashtags || '').trim(),
      imageTip: String(parsed.imageTip || '').trim(),
      photoUrl: typeof photoUrl === 'string' ? photoUrl : null,
      usedPhoto: Boolean(imagePart),
      format: fmt,
      audience: aud,
      locale: lang
    });
  } catch (error: any) {
    console.error('Error generating plant promo:', error);
    const msg = String(error?.message || error || '');
    if (msg.toLowerCase().includes('gemini_api_key') || msg.toLowerCase().includes('not configured')) {
      res.status(500).json({
        error: 'GEMINI_API_KEY is missing on the server. Add it in Railway → Variables, then redeploy.',
        details: msg
      });
      return;
    }
    const statusCode = getApiStatusCode(error);
    if (statusCode === 429 || statusCode === 503) {
      res.status(503).json({
        error: 'AI service is temporarily busy. Please try again in a few seconds.',
        details: msg
      });
      return;
    }
    res.status(500).json({
      error: 'Failed to generate marketing copy.',
      details: msg
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
