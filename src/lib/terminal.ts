/**
 * Stripe Terminal SDK wrapper for the Retail POS tab.
 *
 * Uses @stripe/terminal-js which loads the SDK from Stripe's CDN.
 * In test mode we use the built-in simulated reader — no hardware needed.
 */
import { loadStripeTerminal, type Terminal, type Reader } from '@stripe/terminal-js';

let terminal: Terminal | null = null;
let connectedReader: Reader | null = null;

export function getTerminal(): Terminal | null {
  return terminal;
}

export function getConnectedReader(): Reader | null {
  return connectedReader;
}

/**
 * Initialise the Stripe Terminal SDK.
 * `fetchConnectionToken` should POST to /api/terminal/connection-token and return `{ secret }`.
 */
export async function initTerminal(
  fetchConnectionToken: () => Promise<string>
): Promise<Terminal> {
  if (terminal) return terminal;

  const StripeTerminal = await loadStripeTerminal();
  if (!StripeTerminal) throw new Error('Failed to load Stripe Terminal SDK.');

  terminal = StripeTerminal.create({
    onFetchConnectionToken: fetchConnectionToken,
    onUnexpectedReaderDisconnect: () => {
      console.warn('[terminal] Reader unexpectedly disconnected');
      connectedReader = null;
    }
  });

  return terminal;
}

/**
 * Discover simulated readers (test mode) or internet readers.
 */
export async function discoverReaders(simulated = true): Promise<Reader[]> {
  if (!terminal) throw new Error('Terminal not initialised. Call initTerminal first.');

  const result = await terminal.discoverReaders({ simulated });
  if ('error' in result && result.error) {
    throw new Error(result.error.message || 'Failed to discover readers.');
  }
  return (result as any).discoveredReaders || [];
}

/**
 * Connect to a discovered reader.
 */
export async function connectReader(reader: Reader): Promise<Reader> {
  if (!terminal) throw new Error('Terminal not initialised.');

  const result = await terminal.connectReader(reader);
  if ('error' in result && result.error) {
    throw new Error(result.error.message || 'Failed to connect to reader.');
  }
  connectedReader = (result as any).reader || reader;
  return connectedReader!;
}

/**
 * Collect a card-present payment via the connected reader.
 * `clientSecret` comes from the PaymentIntent created on the server.
 */
export async function collectPayment(
  clientSecret: string
): Promise<{ paymentIntent: any }> {
  if (!terminal) throw new Error('Terminal not initialised.');
  if (!connectedReader) throw new Error('No reader connected.');

  const result = await terminal.collectPaymentMethod(clientSecret);
  if ('error' in result && result.error) {
    throw new Error(result.error.message || 'Payment collection failed.');
  }

  const processResult = await terminal.processPayment((result as any).paymentIntent);
  if ('error' in processResult && processResult.error) {
    throw new Error(processResult.error.message || 'Payment processing failed.');
  }

  return { paymentIntent: (processResult as any).paymentIntent };
}

/**
 * Cancel an in-progress payment collection.
 */
export async function cancelCollectPayment(): Promise<void> {
  if (!terminal) return;
  await terminal.cancelCollectPaymentMethod();
}

/**
 * Disconnect and tear down.
 */
export async function disconnectReader(): Promise<void> {
  if (terminal && connectedReader) {
    await terminal.disconnectReader();
    connectedReader = null;
  }
}
