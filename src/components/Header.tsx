import React, { useState } from 'react';
import { Clock, CheckCircle2, LogOut, CloudUpload } from 'lucide-react';
import { CustomerOrder, MemberRole, TenantMember } from '../types';
import { getFallbackReason, isUsingFallback, reconnectAndSyncToCloud } from '../lib/db';
import { BrandLogo } from './BrandLogo';
import { getMemberRoles, rolesLabel } from '../lib/permissions';

interface HeaderProps {
  orders: CustomerOrder[];
  nurseryName: string;
  userEmail?: string;
  role?: MemberRole;
  member?: Pick<TenantMember, 'role' | 'roles'> | null;
  onSignOut?: () => Promise<void> | void;
  onManageTeam?: () => void;
  onManageWeights?: () => void;
  onManagePackages?: () => void;
  onBackToSeller?: () => void;
  onSelectOrder?: (orderId: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  orders,
  nurseryName,
  userEmail,
  role,
  member,
  onSignOut,
  onManageTeam,
  onManageWeights,
  onManagePackages,
  onBackToSeller,
  onSelectOrder
}) => {
  // Calculate total pending vs total completed orders
  const activeOrders = orders.filter((o) => o.status !== 'completed');
  const completedOrders = orders.filter((o) => o.status === 'completed');
  
  const fallbackActive = isUsingFallback();
  const fallbackReason = getFallbackReason();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

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

  return (
    <header className="bg-emerald-950 text-white shadow-md border-b border-emerald-900">
      <style>{`
        .no-scrollbar::-webkit-scrollbar {
          display: none;
        }
        .no-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          
          {/* Brand Logo & Name */}
          <div className="flex items-center space-x-3">
            <BrandLogo variant="icon" size="md" showText={false} nurseryName={nurseryName} />
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="text-xl font-black tracking-tight font-sans text-emerald-50 uppercase">
                  {nurseryName}
                </h1>
                {fallbackActive && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono animate-pulse">
                    Local Active
                  </span>
                )}
              </div>
              <p className="text-xs text-emerald-300 font-mono uppercase tracking-widest font-bold">
                NurseryOS Workspace
                {(member || role) && (
                  <span className="text-emerald-500 font-normal">
                    {' '}
                    | {member ? rolesLabel(getMemberRoles(member)) : rolesLabel([role as MemberRole])}
                  </span>
                )}
              </p>
            </div>
            {onManageWeights && (
              <button
                type="button"
                onClick={onManageWeights}
                className="ml-1 inline-flex items-center gap-1.5 rounded-lg border border-emerald-800 bg-emerald-900/50 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200 hover:bg-emerald-800"
              >
                Weights
              </button>
            )}
            {onManageTeam && (
              <button
                type="button"
                onClick={onManageTeam}
                className="ml-1 inline-flex items-center gap-1.5 rounded-lg border border-emerald-800 bg-emerald-900/50 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200 hover:bg-emerald-800"
              >
                Team
              </button>
            )}
            {onBackToSeller && (
              <button
                type="button"
                onClick={onBackToSeller}
                className="ml-1 inline-flex items-center gap-1.5 rounded-lg border border-amber-700/50 bg-amber-900/40 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-200 hover:bg-amber-800/50"
              >
                Seller home
              </button>
            )}
            {onManagePackages && (
              <button
                type="button"
                onClick={onManagePackages}
                className="ml-1 inline-flex items-center gap-1.5 rounded-lg border border-amber-700/50 bg-amber-900/40 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-200 hover:bg-amber-800/50"
              >
                Packages
              </button>
            )}
            {onSignOut && (
              <button
                type="button"
                onClick={() => onSignOut()}
                className="ml-2 inline-flex items-center gap-1.5 rounded-lg border border-emerald-800 bg-emerald-900/50 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wide text-emerald-200 hover:bg-emerald-800"
                title={userEmail || 'Sign out'}
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </button>
            )}
          </div>

          {/* Quick Metrics & Sliders */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full md:w-auto lg:max-w-2xl">
            
            {/* Pending Orders scroll */}
            <div className="bg-emerald-900/40 border border-emerald-800/60 rounded-xl px-4 py-2.5 flex flex-col justify-center min-w-[260px] sm:max-w-xs md:max-w-md">
              <div className="flex items-center justify-between mb-1.5 gap-2">
                <div className="flex items-center space-x-1.5">
                  <Clock className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span className="text-[10px] uppercase tracking-wider font-mono text-emerald-300">Pending Orders to Load</span>
                </div>
                <span className="bg-emerald-800/80 text-emerald-100 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold shrink-0">
                  {activeOrders.length} orders
                </span>
              </div>
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 -mx-1 px-1">
                {activeOrders.length === 0 ? (
                  <span className="text-xs text-emerald-400/70 font-mono italic">No pending orders</span>
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
                            : 'bg-emerald-900/80 text-emerald-200 border-emerald-850 hover:bg-emerald-800/95 hover:text-white'
                        }`}
                        title={`Click to view ${o.customerName}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${isCurrentlyLoading ? 'bg-amber-950' : 'bg-emerald-400'}`} />
                        <span className="truncate max-w-[100px]">{o.customerName}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Shipped Today scroll */}
            <div className="bg-emerald-900/40 border border-emerald-800/60 rounded-xl px-4 py-2.5 flex flex-col justify-center min-w-[260px] sm:max-w-xs md:max-w-md">
              <div className="flex items-center justify-between mb-1.5 gap-2">
                <div className="flex items-center space-x-1.5">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span className="text-[10px] uppercase tracking-wider font-mono text-emerald-300">Shipped Today</span>
                </div>
                <span className="bg-emerald-800/80 text-emerald-100 px-1.5 py-0.5 rounded text-[9px] font-mono font-bold shrink-0">
                  {completedOrders.length} shipped
                </span>
              </div>
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 -mx-1 px-1">
                {completedOrders.length === 0 ? (
                  <span className="text-xs text-emerald-400/70 font-mono italic">None shipped today</span>
                ) : (
                  completedOrders.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => onSelectOrder?.(o.id)}
                      className="inline-flex shrink-0 items-center space-x-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-900/80 text-emerald-150 border border-emerald-850 hover:bg-emerald-800/95 hover:text-white transition-all cursor-pointer hover:scale-105 active:scale-95"
                      title={`Click to view completed ${o.customerName}`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
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
              {syncing ? 'Syncing…' : 'Sync to cloud'}
            </button>
          </div>
        </div>
      )}
    </header>
  );
};
