import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Search, Plus, Minus, Trash2, ShoppingCart, CreditCard,
  CheckCircle2, XCircle, Wifi, WifiOff, Loader2
} from 'lucide-react';
import { useT } from '../lib/i18n';
import { AppPermissions } from '../lib/permissions';
import { InventoryPlant, CustomerOrder, PlantOrderItem } from '../types';
import { subscribeToInventory, adjustInventoryForLoadDeltas } from '../lib/inventory';
import { addCustomerOrder } from '../lib/db';
import { authJsonHeaders } from '../lib/apiAuth';
import {
  initTerminal,
  discoverReaders,
  connectReader,
  collectPayment,
  cancelCollectPayment,
  getConnectedReader,
  disconnectReader
} from '../lib/terminal';
import type { Reader } from '@stripe/terminal-js';

interface Props {
  tenantId: string;
  permissions: AppPermissions;
  userId: string;
}

interface CartItem {
  inventoryPlantId: string;
  plantName: string;
  containerSize: string;
  unitPrice: number;
  quantity: number;
  maxAvailable: number;
}

type CheckoutState = 'idle' | 'creating' | 'collecting' | 'processing' | 'success' | 'error';

const TAX_STORAGE_KEY = 'nurseryos:retailTaxRate';

function loadTaxRate(): number {
  try {
    const v = localStorage.getItem(TAX_STORAGE_KEY);
    if (v) return parseFloat(v) || 0;
  } catch {}
  return 0;
}

export function RetailWorkspace({ tenantId, permissions, userId }: Props) {
  const t = useT();

  // --- Inventory ---
  const [plants, setPlants] = useState<InventoryPlant[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    return subscribeToInventory(setPlants);
  }, []);

  const filteredPlants = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return plants.filter((p) => p.quantityAvailable > 0);
    return plants.filter(
      (p) =>
        p.quantityAvailable > 0 &&
        (p.plantName.toLowerCase().includes(q) ||
          p.containerSize.toLowerCase().includes(q) ||
          (p.category || '').toLowerCase().includes(q))
    );
  }, [plants, searchQuery]);

  // --- Cart ---
  const [cart, setCart] = useState<CartItem[]>([]);
  const [customerName, setCustomerName] = useState('Walk-in Customer');
  const [taxRate, setTaxRate] = useState(loadTaxRate);

  const subtotal = useMemo(
    () => cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
    [cart]
  );
  const taxAmount = subtotal * (taxRate / 100);
  const total = subtotal + taxAmount;

  function addToCart(plant: InventoryPlant) {
    setCart((prev) => {
      const existing = prev.find((c) => c.inventoryPlantId === plant.id);
      if (existing) {
        if (existing.quantity >= existing.maxAvailable) return prev;
        return prev.map((c) =>
          c.inventoryPlantId === plant.id ? { ...c, quantity: c.quantity + 1 } : c
        );
      }
      return [
        ...prev,
        {
          inventoryPlantId: plant.id,
          plantName: plant.plantName,
          containerSize: plant.containerSize,
          unitPrice: plant.listPrice ?? 0,
          quantity: 1,
          maxAvailable: plant.quantityAvailable
        }
      ];
    });
  }

  function updateQty(plantId: string, delta: number) {
    setCart((prev) =>
      prev
        .map((c) =>
          c.inventoryPlantId === plantId
            ? { ...c, quantity: Math.max(0, Math.min(c.maxAvailable, c.quantity + delta)) }
            : c
        )
        .filter((c) => c.quantity > 0)
    );
  }

  function removeFromCart(plantId: string) {
    setCart((prev) => prev.filter((c) => c.inventoryPlantId !== plantId));
  }

  // --- Tax rate persistence ---
  useEffect(() => {
    try {
      localStorage.setItem(TAX_STORAGE_KEY, String(taxRate));
    } catch {}
  }, [taxRate]);

  // --- Stripe Terminal ---
  const [readerStatus, setReaderStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [readerLabel, setReaderLabel] = useState('');
  const [checkoutState, setCheckoutState] = useState<CheckoutState>('idle');
  const [checkoutError, setCheckoutError] = useState('');
  const terminalInitRef = useRef(false);

  async function fetchConnectionToken(): Promise<string> {
    const headers = await authJsonHeaders();
    const res = await fetch('/api/terminal/connection-token', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tenantId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to get connection token');
    return data.secret;
  }

  async function handleConnectReader() {
    try {
      setReaderStatus('connecting');
      if (!terminalInitRef.current) {
        await initTerminal(fetchConnectionToken);
        terminalInitRef.current = true;
      }
      const readers = await discoverReaders(true); // simulated
      if (readers.length === 0) {
        setReaderStatus('disconnected');
        return;
      }
      const reader = await connectReader(readers[0]);
      setReaderLabel(reader.label || 'Simulated Reader');
      setReaderStatus('connected');
    } catch (err: any) {
      console.error('[retail] connect reader failed', err);
      setReaderStatus('disconnected');
    }
  }

  async function handleDisconnectReader() {
    await disconnectReader();
    setReaderStatus('disconnected');
    setReaderLabel('');
  }

  // --- Charge ---
  async function handleCharge() {
    if (cart.length === 0 || total < 0.5) return;
    setCheckoutState('creating');
    setCheckoutError('');

    try {
      // 1. Create PaymentIntent
      const headers = await authJsonHeaders();
      const piRes = await fetch('/api/terminal/create-payment-intent', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tenantId,
          amountCents: Math.round(total * 100),
          customerName,
          cartSummary: cart.map((c) => `${c.quantity}x ${c.plantName} ${c.containerSize}`).join(', ').slice(0, 500)
        })
      });
      const piData = await piRes.json();
      if (!piRes.ok) throw new Error(piData.error || 'Failed to create payment');

      // 2. Collect payment on reader
      setCheckoutState('collecting');
      const { paymentIntent } = await collectPayment(piData.clientSecret);

      // 3. Process success
      setCheckoutState('processing');

      // 4. Create retail order
      const orderItems: PlantOrderItem[] = cart.map((c, i) => ({
        id: `item-${i}`,
        plantName: c.plantName,
        containerSize: c.containerSize,
        quantity: c.quantity,
        loadedQuantity: c.quantity,
        unitPrice: c.unitPrice
      }));

      await addCustomerOrder({
        customerName,
        orderNumber: `R-${Date.now()}`,
        items: orderItems,
        originalText: `Retail POS sale · ${new Date().toLocaleDateString()}`,
        status: 'completed',
        totalWeightLbs: 0,
        source: 'retail'
      });

      // 5. Decrement inventory
      const deltas = cart.map((c) => ({
        plantName: c.plantName,
        containerSize: c.containerSize,
        delta: c.quantity
      }));
      await adjustInventoryForLoadDeltas(deltas, tenantId);

      setCheckoutState('success');

      // Auto-clear after 3 seconds
      setTimeout(() => {
        setCart([]);
        setCustomerName('Walk-in Customer');
        setCheckoutState('idle');
      }, 3000);
    } catch (err: any) {
      console.error('[retail] charge failed', err);
      setCheckoutError(err.message || 'Payment failed');
      setCheckoutState('error');
    }
  }

  async function handleCancelPayment() {
    try {
      await cancelCollectPayment();
    } catch {}
    setCheckoutState('idle');
    setCheckoutError('');
  }

  // --- UI ---
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-full max-h-[calc(100vh-10rem)] overflow-hidden">
      {/* Left panel — inventory search */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Reader status bar */}
        <div className="flex items-center gap-2 mb-3 px-1">
          {readerStatus === 'connected' ? (
            <button
              onClick={handleDisconnectReader}
              className="flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-50 px-3 py-1.5 rounded-lg"
            >
              <Wifi className="h-3.5 w-3.5" />
              {readerLabel}
            </button>
          ) : (
            <button
              onClick={handleConnectReader}
              disabled={readerStatus === 'connecting'}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-500 bg-gray-100 px-3 py-1.5 rounded-lg hover:bg-gray-200 disabled:opacity-50"
            >
              {readerStatus === 'connecting' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <WifiOff className="h-3.5 w-3.5" />
              )}
              {readerStatus === 'connecting' ? t('retail.connecting') : t('retail.connectReader')}
            </button>
          )}
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('retail.searchPlants')}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-ink-500"
          />
        </div>

        {/* Plant list */}
        <div className="flex-1 overflow-y-auto space-y-1">
          {filteredPlants.map((plant) => {
            const inCart = cart.find((c) => c.inventoryPlantId === plant.id);
            return (
              <button
                key={plant.id}
                onClick={() => addToCart(plant)}
                className="w-full text-left px-3 py-2.5 rounded-xl border border-gray-100 hover:bg-ink-50 transition-colors flex items-center justify-between"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">{plant.plantName}</div>
                  <div className="text-xs text-gray-500">
                    {plant.containerSize}
                    {plant.category ? ` · ${plant.category}` : ''}
                    {' · '}
                    <span className="text-gray-400">{plant.quantityAvailable} {t('retail.avail')}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {plant.listPrice != null && (
                    <span className="text-sm font-semibold text-gray-700">{fmt(plant.listPrice)}</span>
                  )}
                  {inCart && (
                    <span className="text-xs font-bold text-ink-600 bg-ink-100 px-1.5 py-0.5 rounded-md">
                      {inCart.quantity}
                    </span>
                  )}
                  <Plus className="h-4 w-4 text-gray-400" />
                </div>
              </button>
            );
          })}
          {filteredPlants.length === 0 && (
            <div className="text-center text-sm text-gray-400 py-12">{t('retail.noResults')}</div>
          )}
        </div>
      </div>

      {/* Right panel — cart */}
      <div className="w-full lg:w-96 flex-shrink-0 flex flex-col overflow-hidden bg-white border border-gray-150 rounded-2xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <ShoppingCart className="h-4 w-4 text-gray-500" />
          <span className="text-sm font-bold text-gray-700">{t('retail.cart')}</span>
          <span className="text-xs text-gray-400">({cart.length})</span>
        </div>

        {/* Customer name */}
        <input
          type="text"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          className="mb-3 w-full px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-ink-400"
          placeholder="Customer name"
        />

        {/* Cart items */}
        <div className="flex-1 overflow-y-auto space-y-2 mb-3">
          {cart.map((item) => (
            <div key={item.inventoryPlantId} className="flex items-center gap-2 text-sm">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-800 truncate">{item.plantName}</div>
                <div className="text-xs text-gray-400">{item.containerSize} · {fmt(item.unitPrice)}</div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => updateQty(item.inventoryPlantId, -1)}
                  className="p-1 rounded hover:bg-gray-100"
                >
                  <Minus className="h-3 w-3" />
                </button>
                <span className="w-6 text-center text-xs font-bold">{item.quantity}</span>
                <button
                  onClick={() => updateQty(item.inventoryPlantId, 1)}
                  className="p-1 rounded hover:bg-gray-100"
                >
                  <Plus className="h-3 w-3" />
                </button>
                <button
                  onClick={() => removeFromCart(item.inventoryPlantId)}
                  className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
              <div className="w-16 text-right text-xs font-semibold text-gray-700">
                {fmt(item.unitPrice * item.quantity)}
              </div>
            </div>
          ))}
          {cart.length === 0 && (
            <div className="text-center text-xs text-gray-400 py-8">{t('retail.emptyCart')}</div>
          )}
        </div>

        {/* Totals */}
        <div className="border-t border-gray-100 pt-3 space-y-1.5">
          <div className="flex justify-between text-xs text-gray-500">
            <span>{t('retail.subtotal')}</span>
            <span>{fmt(subtotal)}</span>
          </div>
          <div className="flex items-center justify-between text-xs text-gray-500">
            <div className="flex items-center gap-1">
              <span>{t('retail.tax')}</span>
              <input
                type="number"
                min="0"
                max="20"
                step="0.1"
                value={taxRate}
                onChange={(e) => setTaxRate(parseFloat(e.target.value) || 0)}
                className="w-12 px-1 py-0.5 border border-gray-200 rounded text-center text-xs"
              />
              <span>%</span>
            </div>
            <span>{fmt(taxAmount)}</span>
          </div>
          <div className="flex justify-between text-sm font-bold text-gray-900">
            <span>{t('retail.total')}</span>
            <span>{fmt(total)}</span>
          </div>
        </div>

        {/* Charge / status */}
        <div className="mt-4">
          {checkoutState === 'idle' && (
            <button
              onClick={handleCharge}
              disabled={cart.length === 0 || readerStatus !== 'connected'}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold text-white bg-ink-700 hover:bg-ink-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <CreditCard className="h-4 w-4" />
              {t('retail.charge')} {fmt(total)}
            </button>
          )}

          {(checkoutState === 'creating' || checkoutState === 'processing') && (
            <div className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium text-gray-600 bg-gray-100">
              <Loader2 className="h-4 w-4 animate-spin" />
              {checkoutState === 'creating' ? t('retail.creatingPayment') : t('retail.processing')}
            </div>
          )}

          {checkoutState === 'collecting' && (
            <div className="space-y-2">
              <div className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium text-blue-700 bg-blue-50">
                <CreditCard className="h-4 w-4 animate-pulse" />
                {t('retail.waitingForCard')}
              </div>
              <button
                onClick={handleCancelPayment}
                className="w-full text-xs text-gray-500 hover:text-gray-700 py-1"
              >
                {t('retail.cancel')}
              </button>
            </div>
          )}

          {checkoutState === 'success' && (
            <div className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold text-green-700 bg-green-50">
              <CheckCircle2 className="h-4 w-4" />
              {t('retail.paymentSuccess')}
            </div>
          )}

          {checkoutState === 'error' && (
            <div className="space-y-2">
              <div className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-medium text-red-700 bg-red-50">
                <XCircle className="h-4 w-4" />
                {checkoutError || t('retail.paymentFailed')}
              </div>
              <button
                onClick={() => { setCheckoutState('idle'); setCheckoutError(''); }}
                className="w-full text-xs text-gray-500 hover:text-gray-700 py-1"
              >
                {t('retail.tryAgain')}
              </button>
            </div>
          )}

          {readerStatus !== 'connected' && checkoutState === 'idle' && (
            <p className="text-xs text-center text-gray-400 mt-2">{t('retail.connectReaderHint')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
