import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';

dotenv.config();

const app = express();
// Increase payload limit to handle base64 PDFs and images
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = Number(process.env.PORT) || 3000;

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

const GEMINI_REQUEST_TIMEOUT_MS = 90_000;
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
  return msg.includes('high demand') || msg.includes('unavailable') || msg.includes('rate limit');
}

function isSkippableModelError(error: any): boolean {
  const status = getApiStatusCode(error);
  if (status === 404) return true;
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('no longer available') || msg.includes('not found');
}

const PARSE_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
] as const;

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
      config: getOrderParseSchema()
    }),
    `Order parse (${model})`
  );
}

async function parseOrderWithFallback(
  ai: GoogleGenAI,
  mimeType: string,
  cleanBase64: string,
  prompt: string
) {
  let lastError: any = null;
  const maxAttemptsPerModel = 2;

  for (const model of PARSE_MODELS) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt += 1) {
      try {
        console.log(`Parsing order with ${model} (attempt ${attempt}/${maxAttemptsPerModel})...`);
        const response = await generateOrderParseResponse(ai, model, mimeType, cleanBase64, prompt);
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
    const { base64Data, mimeType, fileName } = req.body;

    if (!base64Data || !mimeType) {
      res.status(400).json({ error: 'Missing base64Data or mimeType.' });
      return;
    }

    const ai = getAiClient();

    // Clean up base64 prefix if present
    const cleanBase64 = base64Data.replace(/^data:.*?;base64,/, '');

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
   - 'B&B' (for balled and burlapped, B&B trees, Caliper trees)
   - '4 inch' (for 4" pots)
   - '6 inch' (for 6" pots)
   - 'Tray' (for plant flats, plug trays, or groundcover trays)
   - 'Other' (if it doesn't fit any of the above, keep the size as reported)

4. Generate a beautifully formatted plain-text representation (plainText) of the order.
This text is meant for nursery workers loading trucks, so make it incredibly clear, bolding quantities and container sizes, listing plants in a neat checklist format with checkboxes [ ]. Exclude irrelevant invoice headers, tax calculations, or billing terms. Focus 100% on what plants need to be loaded!

Return your response in structured JSON format matching the schema provided.`;

    let response: any = null;
    response = await parseOrderWithFallback(ai, mimeType, cleanBase64, prompt);

    const responseText = response.text;
    if (!responseText) {
      throw new Error('Gemini model returned empty response.');
    }

    const parsedData = JSON.parse(responseText);
    res.json(parsedData);
  } catch (error: any) {
    console.error('Error parsing order with Gemini:', error);
    const statusCode = getApiStatusCode(error);
    if (statusCode === 429 || statusCode === 503) {
      res.status(503).json({
        error: 'AI service is temporarily busy. Please try again in a few seconds.',
        details: error.message || error
      });
      return;
    }
    res.status(500).json({
      error: 'Failed to process order document.',
      details: error.message || error
    });
  }
});

// API endpoint to parse inventory files (PDF/image/excel) into live inventory items
app.post('/api/parse-inventory', async (req, res) => {
  try {
    const { base64Data, mimeType, fileName } = req.body;
    if (!base64Data || !mimeType) {
      res.status(400).json({ error: 'Missing base64Data or mimeType.' });
      return;
    }

    const ai = getAiClient();
    const cleanBase64 = base64Data.replace(/^data:.*?;base64,/, '');
    const prompt = `Analyze this nursery inventory source file (${fileName || 'inventory file'}).
Extract a clean plant inventory list where each item includes:
1) plantName
2) containerSize (standardized if possible: #1, #3, #5, #7, #10, #15, #30, #45, B&B, 4 inch, 6 inch, Tray, Other)
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

// API endpoint to send invoice emails
app.post('/api/send-invoice', async (req, res) => {
  try {
    const { to, subject, text, html } = req.body;

    if (!to || !subject || (!text && !html)) {
      res.status(400).json({ error: 'Missing required email fields (to, subject, text/html).' });
      return;
    }

    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SENDER_EMAIL || user;

    if (!host || !port || !user || !pass) {
      res.status(200).json({
        success: false,
        code: 'SMTP_NOT_CONFIGURED',
        message: 'SMTP settings (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS) are not configured.'
      });
      return;
    }

    // Create transporter
    const transporter = nodemailer.createTransport({
      host,
      port: Number(port),
      secure: Number(port) === 465, // true for 465, false for other ports
      auth: {
        user,
        pass,
      },
      // Increase timeout values for reliability
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });

    // Send mail
    const info = await transporter.sendMail({
      from: `"Bayou State Plant Co." <${from}>`,
      to,
      subject,
      text,
      html,
    });

    console.log('Invoice email sent successfully:', info.messageId);
    res.json({ success: true, messageId: info.messageId });
  } catch (error: any) {
    console.error('Error sending invoice email:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send email via SMTP server.',
      details: error.message || error
    });
  }
});

// Check server status & API key configuration
app.get('/api/config-status', (req, res) => {
  res.json({
    hasGeminiKey: !!process.env.GEMINI_API_KEY
  });
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
