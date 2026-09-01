import React, { useState } from 'react';
import { Clock, CheckCircle2, LogOut, CloudUpload, RefreshCw } from 'lucide-react';
import { CustomerOrder, MemberRole, TenantMember } from '../types';
import { getFallbackReason, isUsingFallback, reconnectAndSyncToCloud } from '../lib/db';
import { BrandLogo } from './BrandLogo';
import { getMemberRoles } from '../lib/permissions';
import { useRoleLabel, useT } from '../lib/i18n';

interface HeaderProps {
  orders: CustomerOrder[];
  nurseryName: string;
  userEmail?: string;
  role?: MemberRole;
  member?: Pick<TenantMember, 'role' | 'roles'> | null;
  onSignOut?: () => Promise<void> | void;
  onManageTeam?: () => void;
  onManagePackages?: () => void;
  onBackToSeller?: () => void;
  onSelectOrder?: (orderId: string) => void;
}

async function hardReloadApp(): Promise<void> {
  // Home-screen / standalone web apps often keep a stale shell; clear what we can, then reload.
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // ignore
  }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        regs.map((reg) => {
          const scriptUrl =
            reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '';
          if (scriptUrl.includes('firebase-messaging-sw')) return Promise.resolve(false);
          return reg.unregister();
        })
      );
    }
  } catch {
    // ignore
  }
  window.location.reload();
}

export const Header: React.FC<HeaderProps> = ({
  orders,
  nurseryName,
  userEmail,
  role,
  member,
  onSignOut,
  onManageTeam,
  onManagePackages,
  onBackToSeller,
  onSelectOrder
}) => {
  const t = useT();
  const { rolesLabel } = useRoleLabel();
  // Calculate total pending vs total completed orders
  const activeOrders = orders.filter((o) => o.status !== 'completed');
  const completedOrders = orders.filter((o) => o.status === 'completed');
  
  const fallbackActive = isUsingFallback();
  const fallbackReason = getFallbackReason();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  async function handleSyncToCloud() {
    setSyncing(true);
    setSyncError(null);
    try {
      await reconnectAndSyncToCloud();
    } catch (err: any) {
      setSyncError(err?.message || 'Could not sync to cloud.');
      setSyncing(false);
    }
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await hardReloadApp();
    } catch {
      setRefreshing(false);
    }
  }

  return (
    <header className="bg-ink-950 text-white shadow-md border-b border-ink-900 pt-[env(safe-area-inset-top)]">
      <style>{`
        .no-scrollbar::-webkit-scrollbar {
          display: none;
        }
        .no-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 sm:py-4">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 md:gap-4">
          
          {/* Brand + actions — wrap so Refresh/Sign out are never clipped on phones */}
          <div className="flex flex-col gap-2.5 min-w-0 w-full md:w-auto">
            <div className="flex items-center gap-3 min-w-0">
              <BrandLogo variant="icon" size="md" showText={false} nurseryName={nurseryName} />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-lg sm:text-xl font-black tracking-tight font-sans text-ink-50 uppercase truncate">
                    {nurseryName}
                  </h1>
                  {fallbackActive && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono animate-pulse">
                      {t('header.localActive')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-ink-300 font-mono uppercase tracking-widest font-bold truncate">
                  {t('header.workspace')}
                  {(member || role) && (
                    <span className="text-ink-500 font-normal">
                      {' '}
                      | {member ? rolesLabel(getMemberRoles(member)) : rolesLabel([role as MemberRole])}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {onManageTeam && (
                <button
                  type="button"
                  onClick={onManageTeam}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/30 bg-white/10 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-white hover:bg-white/20"
                >
                  {t('header.team')}
                </button>
              )}
              {onBackToSeller && (
                <button
                  type="button"
                  onClick={onBackToSeller}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/50 bg-amber-400/15 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-100 hover:bg-amber-400/25"
                >
                  {t('header.sellerHome')}
                </button>
              )}
              {onManagePackages && (
                <button
                  type="button"
                  onClick={onManagePackages}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300/50 bg-amber-400/15 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-100 hover:bg-amber-400/25"
                >
                  {t('header.packages')}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/30 bg-white/10 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-white hover:bg-white/20 disabled:opacity-60"
                title={t('header.refreshHint')}
              >
                <RefreshCw className={`h-3.5 w-3.5 shrink-0 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? t('header.refreshing') : t('header.refresh')}
              </button>
              {onSignOut && (
                <button
                  type="button"
                  onClick={() => onSignOut()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/30 bg-white/10 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-white hover:bg-white/20"
                  title={userEmail || t('common.signOut')}
                >
                  <LogOut className="h-3.5 w-3.5 shrink-0" />
                  {t('common.signOut')}
                </button>
              )}
            </div>
          </div>

          {/* Quick Metrics & Sliders */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full md:w-auto lg:max-w-2xl">
            
            {/* Pending Orders scroll */}
            <div className="bg-white/5 border border-white/20 rounded-xl px-4 py-2.5 flex flex-col justify-center min-w-[260px] sm:max-w-xs md:max-w-md">
              <div className="flex items-center justify-between mb-1.5 gap-2">
                <div className="flex items-center space-x-1.5">
                  <Clock className="h-4 w-4 text-white/70 shrink-0" />
                  <span className="text-[10px] uppercase tracking-wider font-mono text-white/80">{t('header.pendingToLoad')}</span>
                </div>
                <span className="bg-white/15 text-white px-1.5 py-0.5 rounded text-[9px] font-mono font-bold shrink-0 border border-white/20">
                  {t('header.ordersCount', { count: activeOrders.length })}
                </span>
              </div>
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 -mx-1 px-1">
                {activeOrders.length === 0 ? (
                  <span className="text-xs text-white/50 font-mono italic">{t('header.noPending')}</span>
                ) : (
                  activeOrders.map((o) => {
                    const isCurrentlyLoading = o.status === 'loading';
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => onSelectOrder?.(o.id)}
                        className={`inline-flex shrink-0 items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-bold border transition-all cursor-pointer hover:scale-105 active:scale-95 ${
                          isCurrentlyLoading
                            ? 'bg-amber-500 text-amber-950 border-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.25)] animate-pulse'
                            : 'bg-white/10 text-white border-white/30 hover:bg-white/20'
                        }`}
                        title={`Click to view ${o.customerName}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${isCurrentlyLoading ? 'bg-amber-950' : 'bg-white/80'}`} />
                        <span className="truncate max-w-[100px]">{o.customerName}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Shipped Today scroll */}
            <div className="bg-white/5 border border-white/20 rounded-xl px-4 py-2.5 flex flex-col justify-center min-w-[260px] sm:max-w-xs md:max-w-md">
              <div className="flex items-center justify-between mb-1.5 gap-2">
                <div className="flex items-center space-x-1.5">
                  <CheckCircle2 className="h-4 w-4 text-white/70 shrink-0" />
                  <span className="text-[10px] uppercase tracking-wider font-mono text-white/80">{t('header.shippedToday')}</span>
                </div>
                <span className="bg-white/15 text-white px-1.5 py-0.5 rounded text-[9px] font-mono font-bold shrink-0 border border-white/20">
                  {t('header.shippedCount', { count: completedOrders.length })}
                </span>
              </div>
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 -mx-1 px-1">
                {completedOrders.length === 0 ? (
                  <span className="text-xs text-white/50 font-mono italic">{t('header.noneShippedToday')}</span>
                ) : (
                  completedOrders.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => onSelectOrder?.(o.id)}
                      className="inline-flex shrink-0 items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-white/10 text-white border border-white/30 hover:bg-white/20 transition-all cursor-pointer hover:scale-105 active:scale-95"
                      title={`Click to view completed ${o.customerName}`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-white/80 shrink-0" />
                      <span className="truncate max-w-[100px]">{o.customerName}</span>
                    </button>
                  ))
                )}
              </div>
            </div>

          </div>

        </div>
      </div>

      {fallbackActive && (
        <div className="border-t border-amber-500/30 bg-amber-500/15 px-4 py-2.5">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
            <p className="text-[11px] text-amber-100 leading-relaxed">
              <span className="font-black">Local Active:</span> this device is offline from the nursery
              cloud. Trucks/orders saved here won&apos;t show for loaders on phones or other computers
              until you sync.
              {fallbackReason ? (
                <span className="block sm:inline sm:ml-1 text-amber-200/80 font-mono">
                  ({fallbackReason})
                </span>
              ) : null}
              {syncError ? (
                <span className="block text-red-200 font-semibold mt-1">{syncError}</span>
              ) : null}
            </p>
            <button
              type="button"
              disabled={syncing}
              onClick={() => void handleSyncToCloud()}
              className="inline-flex items-center justify-center gap-1.5 shrink-0 rounded-lg bg-amber-400 hover:bg-amber-300 text-amber-950 px-3 py-2 text-[11px] font-black disabled:opacity-60"
            >
              <CloudUpload className="h-3.5 w-3.5" />
              {syncing ? t('header.syncing') : t('header.syncToCloud')}
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
