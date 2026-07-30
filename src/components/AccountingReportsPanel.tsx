import { useMemo, useState } from 'react';
import {
  Building2,
  Calculator,
  CreditCard,
  Download,
  FileSpreadsheet,
  Landmark,
  Receipt,
  Scale,
  Wallet
} from 'lucide-react';
import { CustomerDocument, InventoryPlant, VendorBill } from '../types';
import { useT } from '../lib/i18n';
import {
  AccountingPeriod,
  AgingBucketId,
  buildApAging,
  buildArAging,
  buildBalanceSheet,
  buildCashMovement,
  buildExpenseReport,
  buildProfitAndLoss,
  buildSalesTaxReport,
  downloadCsv,
  exportBalanceSheetCsv,
  exportProfitAndLossCsv
} from '../lib/accountingReports';

type AccountingReportId =
  | 'pnl'
  | 'balance'
  | 'ar'
  | 'ap'
  | 'tax'
  | 'cash'
  | 'expenses';

interface AccountingReportsPanelProps {
  documents: CustomerDocument[];
  bills: VendorBill[];
  inventory: InventoryPlant[];
  canViewPurchasing: boolean;
}

function money(n: number) {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function pct(n: number) {
  return `${n.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  })}%`;
}

export function AccountingReportsPanel({
  documents,
  bills,
  inventory,
  canViewPurchasing
}: AccountingReportsPanelProps) {
  const t = useT();
  const [reportId, setReportId] = useState<AccountingReportId>('pnl');
  const [period, setPeriod] = useState<AccountingPeriod>('month');

  const periodOptions: Array<{ id: AccountingPeriod; label: string }> = [
    { id: 'month', label: t('reports.acctPeriodMonth') },
    { id: 'quarter', label: t('reports.acctPeriodQuarter') },
    { id: 'year', label: t('reports.acctPeriodYear') },
    { id: 'all', label: t('reports.acctPeriodAll') }
  ];

  const reportTabs: Array<{
    id: AccountingReportId;
    label: string;
    icon: typeof Calculator;
    needsPurchasing?: boolean;
  }> = [
    { id: 'pnl', label: t('reports.acctPnl'), icon: Calculator },
    { id: 'balance', label: t('reports.acctBalance'), icon: Scale },
    { id: 'ar', label: t('reports.acctAr'), icon: Building2 },
    { id: 'ap', label: t('reports.acctAp'), icon: Landmark, needsPurchasing: true },
    { id: 'tax', label: t('reports.acctTax'), icon: Receipt },
    { id: 'cash', label: t('reports.acctCash'), icon: Wallet },
    { id: 'expenses', label: t('reports.acctExpenses'), icon: CreditCard, needsPurchasing: true }
  ];

  const agingBucketLabel = (id: AgingBucketId) => {
    if (id === 'current') return t('reports.agingCurrent');
    if (id === 'b1_30') return t('reports.aging1_30');
    if (id === 'b31_60') return t('reports.aging31_60');
    if (id === 'b61_90') return t('reports.aging61_90');
    return t('reports.aging90Plus');
  };

  const periodLabel =
    periodOptions.find((p) => p.id === period)?.label || period;

  const pnl = useMemo(
    () => buildProfitAndLoss(documents, bills, period),
    [documents, bills, period]
  );
  const balance = useMemo(
    () => buildBalanceSheet(documents, bills, inventory),
    [documents, bills, inventory]
  );
  const ar = useMemo(() => buildArAging(documents), [documents]);
  const ap = useMemo(() => buildApAging(bills), [bills]);
  const tax = useMemo(() => buildSalesTaxReport(documents, period), [documents, period]);
  const cash = useMemo(
    () => buildCashMovement(documents, bills, period),
    [documents, bills, period]
  );
  const expenses = useMemo(() => buildExpenseReport(bills, period), [bills, period]);

  const showPeriod = reportId === 'pnl' || reportId === 'tax' || reportId === 'cash' || reportId === 'expenses';
  const needsPurchasing =
    reportId === 'ap' ||
    reportId === 'expenses' ||
    reportId === 'pnl' ||
    reportId === 'cash' ||
    reportId === 'balance';
  const missingPurchasing = needsPurchasing && !canViewPurchasing;

  function exportPnl() {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(
      `profit-and-loss-${period}-${stamp}.csv`,
      exportProfitAndLossCsv(pnl, {
        period: periodLabel,
        grossRevenue: t('reports.acctGrossRevenue'),
        salesTax: t('reports.acctLessSalesTax'),
        netSales: t('reports.acctNetSales'),
        freight: t('reports.acctFreightIncome'),
        discounts: t('reports.acctDiscounts'),
        cogs: t('reports.acctCogs'),
        grossProfit: t('reports.acctGrossProfit'),
        opEx: t('reports.acctOpEx'),
        netOperating: t('reports.acctNetOperating'),
        category: t('reports.acctCategory'),
        amount: t('reports.acctAmount'),
        section: t('reports.acctSection'),
        line: t('reports.acctLine')
      })
    );
  }

  function exportBalance() {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(
      `balance-sheet-${balance.asOf}.csv`,
      exportBalanceSheetCsv(balance, {
        asOf: balance.asOf,
        section: t('reports.acctSection'),
        line: t('reports.acctLine'),
        amount: t('reports.acctAmount'),
        cash: t('reports.acctBsCash'),
        ar: t('reports.acctBsAr'),
        inventory: t('reports.acctBsInventory'),
        totalAssets: t('reports.acctBsTotalAssets'),
        ap: t('reports.acctBsAp'),
        salesTax: t('reports.acctBsSalesTax'),
        totalLiabilities: t('reports.acctBsTotalLiabilities'),
        equity: t('reports.acctBsEquity'),
        totalLiabEquity: t('reports.acctBsTotalLiabEquity')
      })
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 px-4 py-3">
        <div className="flex items-start gap-2.5">
          <FileSpreadsheet className="h-4 w-4 text-emerald-800 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-emerald-950">{t('reports.acctIntroTitle')}</p>
            <p className="text-xs text-emerald-900/80 mt-0.5 leading-relaxed">
              {t('reports.acctIntroBody')}
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {reportTabs.map((tab) => {
          const Icon = tab.icon;
          const active = reportId === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setReportId(tab.id)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[11px] font-bold border transition-colors ${
                active
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {showPeriod && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
            {t('reports.acctPeriod')}
          </span>
          {periodOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setPeriod(opt.id)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border ${
                period === opt.id
                  ? 'bg-ink-600 text-white border-ink-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {missingPurchasing && (
        <p className="text-xs text-amber-800 font-semibold bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
          {t('reports.acctNeedPurchasing')}
        </p>
      )}

      {reportId === 'pnl' && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <ExportButton label={t('reports.acctExportCsv')} onClick={exportPnl} />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label={t('reports.acctNetSales')} value={money(pnl.revenue - pnl.salesTax)} hint={periodLabel} />
            <StatCard label={t('reports.acctCogs')} value={money(pnl.cogs)} hint={t('reports.acctInvoiceCount', { n: pnl.invoiceCount })} />
            <StatCard
              label={t('reports.acctGrossProfit')}
              value={money(pnl.grossProfit)}
              hint={t('reports.acctGrossMargin', { pct: pct(pnl.grossMarginPct) })}
            />
            <StatCard
              label={t('reports.acctNetOperating')}
              value={money(pnl.netOperating)}
              hint={t('reports.acctBillCount', { n: pnl.billCount })}
              emphasize
            />
          </div>

          <div className="rounded-2xl border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                <PlRow label={t('reports.acctGrossRevenue')} amount={pnl.revenue} />
                <PlRow label={t('reports.acctLessSalesTax')} amount={-pnl.salesTax} muted />
                <PlRow label={t('reports.acctNetSales')} amount={pnl.revenue - pnl.salesTax} bold />
                <PlRow label={t('reports.acctCogs')} amount={-pnl.cogs} />
                <PlRow label={t('reports.acctGrossProfit')} amount={pnl.grossProfit} bold />
                <PlRow label={t('reports.acctOpEx')} amount={-pnl.operatingExpenses} />
                <PlRow label={t('reports.acctNetOperating')} amount={pnl.netOperating} bold emphasize />
              </tbody>
            </table>
            {(pnl.freightIncome > 0 || pnl.discounts > 0) && (
              <p className="px-4 py-2 text-[11px] text-slate-500 border-t border-slate-100">
                {pnl.freightIncome > 0
                  ? `${t('reports.acctFreightIncome')}: ${money(pnl.freightIncome)}`
                  : ''}
                {pnl.freightIncome > 0 && pnl.discounts > 0 ? ' · ' : ''}
                {pnl.discounts > 0 ? `${t('reports.acctDiscounts')}: ${money(pnl.discounts)}` : ''}
              </p>
            )}
          </div>

          {pnl.expensesByCategory.length > 0 && (
            <div className="rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                <p className="text-xs font-bold text-slate-800">{t('reports.acctOpExByCategory')}</p>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-white text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-100">
                  <tr>
                    <th className="text-left font-bold px-4 py-2">{t('reports.acctCategory')}</th>
                    <th className="text-right font-bold px-4 py-2">{t('reports.acctAmount')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pnl.expensesByCategory.map((row) => (
                    <tr key={row.category}>
                      <td className="px-4 py-2 text-slate-800">{row.category}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">{money(row.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <ul className="space-y-1">
            {pnl.notes.map((note) => (
              <li key={note} className="text-[11px] text-slate-500 leading-relaxed">
                •{' '}
                {note === 'gaap'
                  ? t('reports.acctNoteGaap')
                  : note === 'cogs_bills'
                    ? t('reports.acctNoteCogsBills')
                    : note === 'cogs_empty'
                      ? t('reports.acctNoteCogsEmpty')
                      : note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {reportId === 'balance' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold text-slate-900">{t('reports.acctBsTitle')}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                {t('reports.acctBsSubtitle', { asOf: balance.asOf })}
              </p>
            </div>
            <ExportButton label={t('reports.acctExportCsv')} onClick={exportBalance} />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label={t('reports.acctBsTotalAssets')} value={money(balance.totalAssets)} emphasize />
            <StatCard label={t('reports.acctBsTotalLiabilities')} value={money(balance.totalLiabilities)} />
            <StatCard label={t('reports.acctBsEquity')} value={money(balance.equity)} />
            <StatCard
              label={t('reports.acctBsInventory')}
              value={money(balance.inventoryAtCost)}
              hint={t('reports.acctBsInventoryHint', {
                valued: balance.inventoryValuedUnits,
                unvalued: balance.inventoryUnvaluedUnits
              })}
            />
          </div>

          <div className="grid lg:grid-cols-2 gap-3">
            <div className="rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                <p className="text-xs font-bold text-slate-800">{t('reports.acctBsAssets')}</p>
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  <PlRow label={t('reports.acctBsCash')} amount={balance.cashEstimated} />
                  <PlRow label={t('reports.acctBsAr')} amount={balance.accountsReceivable} />
                  <PlRow label={t('reports.acctBsInventory')} amount={balance.inventoryAtCost} />
                  <PlRow label={t('reports.acctBsTotalAssets')} amount={balance.totalAssets} bold emphasize />
                </tbody>
              </table>
            </div>
            <div className="rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                <p className="text-xs font-bold text-slate-800">{t('reports.acctBsLiabEquity')}</p>
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100">
                  <PlRow label={t('reports.acctBsAp')} amount={balance.accountsPayable} />
                  <PlRow label={t('reports.acctBsSalesTax')} amount={balance.salesTaxPayable} />
                  <PlRow label={t('reports.acctBsTotalLiabilities')} amount={balance.totalLiabilities} bold />
                  <PlRow label={t('reports.acctBsEquity')} amount={balance.equity} />
                  <PlRow
                    label={t('reports.acctBsTotalLiabEquity')}
                    amount={balance.totalLiabilitiesAndEquity}
                    bold
                    emphasize
                  />
                </tbody>
              </table>
            </div>
          </div>

          <ul className="space-y-1">
            {balance.notes.map((note) => (
              <li key={note} className="text-[11px] text-slate-500 leading-relaxed">
                •{' '}
                {note === 'bs_operating'
                  ? t('reports.acctBsNoteOperating')
                  : note === 'bs_cash'
                    ? t('reports.acctBsNoteCash')
                    : note === 'bs_inventory'
                      ? t('reports.acctBsNoteInventory', {
                          unvalued: balance.inventoryUnvaluedUnits
                        })
                      : note === 'bs_tax'
                        ? t('reports.acctBsNoteTax')
                        : note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {reportId === 'ar' && (
        <AgingView
          title={t('reports.acctArTitle')}
          subtitle={t('reports.acctArSubtitle', { asOf: ar.asOf })}
          report={ar}
          nameHeader={t('reports.customer')}
          totalLabel={t('reports.acctTotal')}
          empty={t('reports.acctArEmpty')}
          bucketLabel={agingBucketLabel}
        />
      )}

      {reportId === 'ap' && (
        <AgingView
          title={t('reports.acctApTitle')}
          subtitle={t('reports.acctApSubtitle', { asOf: ap.asOf })}
          report={ap}
          nameHeader={t('reports.acctVendor')}
          totalLabel={t('reports.acctTotal')}
          empty={canViewPurchasing ? t('reports.acctApEmpty') : t('reports.acctNeedPurchasing')}
          bucketLabel={agingBucketLabel}
        />
      )}

      {reportId === 'tax' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <StatCard label={t('reports.acctTaxableSales')} value={money(tax.taxableSales)} hint={periodLabel} />
            <StatCard label={t('reports.acctTaxCollected')} value={money(tax.salesTaxCollected)} emphasize />
            <StatCard label={t('reports.acctInvoices')} value={String(tax.invoiceCount)} />
          </div>
          <div className="rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
              <p className="text-xs font-bold text-slate-800">{t('reports.acctTaxByRate')}</p>
            </div>
            {tax.byRate.length === 0 ? (
              <p className="px-4 py-6 text-xs text-slate-500 text-center">{t('reports.acctTaxEmpty')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-100">
                  <tr>
                    <th className="text-left font-bold px-4 py-2">{t('reports.acctTaxRate')}</th>
                    <th className="text-right font-bold px-4 py-2">{t('reports.acctTaxable')}</th>
                    <th className="text-right font-bold px-4 py-2">{t('reports.acctTaxCol')}</th>
                    <th className="text-right font-bold px-4 py-2">{t('reports.acctInvoices')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tax.byRate.map((row) => (
                    <tr key={row.ratePct}>
                      <td className="px-4 py-2 font-mono">{pct(row.ratePct)}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">{money(row.taxable)}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums font-semibold">{money(row.tax)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{row.invoiceCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {reportId === 'cash' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <StatCard label={t('reports.acctCashIn')} value={money(cash.cashIn)} hint={periodLabel} />
            <StatCard label={t('reports.acctCashOut')} value={money(cash.cashOut)} />
            <StatCard label={t('reports.acctCashNet')} value={money(cash.net)} emphasize />
          </div>

          <div className="grid lg:grid-cols-2 gap-3">
            <MethodTable
              title={t('reports.acctCashInByMethod')}
              rows={cash.inByMethod}
              empty={t('reports.acctCashInEmpty')}
            />
            <MethodTable
              title={t('reports.acctCashOutByMethod')}
              rows={cash.outByMethod}
              empty={canViewPurchasing ? t('reports.acctCashOutEmpty') : t('reports.acctNeedPurchasing')}
            />
          </div>

          <div className="grid lg:grid-cols-2 gap-3">
            <CashRowsTable
              title={t('reports.acctRecentReceipts')}
              rows={cash.inRows}
              nameHeader={t('reports.customer')}
              empty={t('reports.acctCashInEmpty')}
            />
            <CashRowsTable
              title={t('reports.acctRecentPayments')}
              rows={cash.outRows}
              nameHeader={t('reports.acctVendor')}
              empty={canViewPurchasing ? t('reports.acctCashOutEmpty') : t('reports.acctNeedPurchasing')}
            />
          </div>
        </div>
      )}

      {reportId === 'expenses' && (
        <div className="space-y-3">
          <StatCard label={t('reports.acctTotalSpend')} value={money(expenses.total)} hint={periodLabel} emphasize />
          <div className="grid lg:grid-cols-2 gap-3">
            <div className="rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                <p className="text-xs font-bold text-slate-800">{t('reports.acctByCategory')}</p>
              </div>
              {expenses.byCategory.length === 0 ? (
                <p className="px-4 py-6 text-xs text-slate-500 text-center">
                  {canViewPurchasing ? t('reports.acctExpensesEmpty') : t('reports.acctNeedPurchasing')}
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-100">
                    <tr>
                      <th className="text-left font-bold px-4 py-2">{t('reports.acctCategory')}</th>
                      <th className="text-right font-bold px-4 py-2">{t('reports.acctAmount')}</th>
                      <th className="text-right font-bold px-4 py-2">{t('reports.acctBills')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {expenses.byCategory.map((row) => (
                      <tr key={row.category}>
                        <td className="px-4 py-2">{row.category}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">{money(row.amount)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
                <p className="text-xs font-bold text-slate-800">{t('reports.acctByVendor')}</p>
              </div>
              {expenses.byVendor.length === 0 ? (
                <p className="px-4 py-6 text-xs text-slate-500 text-center">
                  {canViewPurchasing ? t('reports.acctExpensesEmpty') : t('reports.acctNeedPurchasing')}
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-100">
                    <tr>
                      <th className="text-left font-bold px-4 py-2">{t('reports.acctVendor')}</th>
                      <th className="text-right font-bold px-4 py-2">{t('reports.acctAmount')}</th>
                      <th className="text-right font-bold px-4 py-2">{t('reports.acctBills')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {expenses.byVendor.map((row) => (
                      <tr key={row.vendor}>
                        <td className="px-4 py-2">{row.vendor}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">{money(row.amount)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ExportButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-white text-[11px] font-bold text-slate-700 hover:bg-slate-50"
    >
      <Download className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function StatCard({
  label,
  value,
  hint,
  emphasize
}: {
  label: string;
  value: string;
  hint?: string;
  emphasize?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border px-3.5 py-3 ${
        emphasize ? 'border-ink-200 bg-ink-50/50' : 'border-slate-200 bg-white'
      }`}
    >
      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-xl font-black text-gray-900 font-mono mt-1 tabular-nums">{value}</p>
      {hint ? <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p> : null}
    </div>
  );
}

function PlRow({
  label,
  amount,
  bold,
  muted,
  emphasize
}: {
  label: string;
  amount: number;
  bold?: boolean;
  muted?: boolean;
  emphasize?: boolean;
}) {
  return (
    <tr className={emphasize ? 'bg-ink-50/40' : undefined}>
      <td
        className={`px-4 py-2.5 ${bold ? 'font-bold text-slate-900' : muted ? 'text-slate-500' : 'text-slate-700'}`}
      >
        {label}
      </td>
      <td
        className={`px-4 py-2.5 text-right font-mono tabular-nums ${
          bold ? 'font-black text-slate-900' : 'text-slate-800'
        }`}
      >
        {money(amount)}
      </td>
    </tr>
  );
}

function AgingView({
  title,
  subtitle,
  report,
  nameHeader,
  totalLabel,
  empty,
  bucketLabel
}: {
  title: string;
  subtitle: string;
  report: ReturnType<typeof buildArAging>;
  nameHeader: string;
  totalLabel: string;
  empty: string;
  bucketLabel: (id: AgingBucketId) => string;
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-bold text-slate-900">{title}</p>
        <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {report.buckets.map((b) => (
          <div key={b.id} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
              {bucketLabel(b.id)}
            </p>
            <p className="text-sm font-black font-mono tabular-nums mt-0.5">{money(b.amount)}</p>
            <p className="text-[10px] text-slate-500">{b.count}</p>
          </div>
        ))}
        <div className="rounded-xl border border-ink-200 bg-ink-50/60 px-3 py-2">
          <p className="text-[10px] font-bold uppercase tracking-wide text-ink-700">{totalLabel}</p>
          <p className="text-sm font-black font-mono tabular-nums mt-0.5">{money(report.total)}</p>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 overflow-x-auto">
        {report.rows.length === 0 ? (
          <p className="px-4 py-6 text-xs text-slate-500 text-center">{empty}</p>
        ) : (
          <table className="w-full text-sm min-w-[640px]">
            <thead className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-100 bg-slate-50">
              <tr>
                <th className="text-left font-bold px-3 py-2">{nameHeader}</th>
                <th className="text-right font-bold px-2 py-2">{bucketLabel('current')}</th>
                <th className="text-right font-bold px-2 py-2">{bucketLabel('b1_30')}</th>
                <th className="text-right font-bold px-2 py-2">{bucketLabel('b31_60')}</th>
                <th className="text-right font-bold px-2 py-2">{bucketLabel('b61_90')}</th>
                <th className="text-right font-bold px-2 py-2">{bucketLabel('b90_plus')}</th>
                <th className="text-right font-bold px-3 py-2">{totalLabel}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {report.rows.map((row) => (
                <tr key={row.name}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{row.name}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-700">{money(row.current)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-700">{money(row.b1_30)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-700">{money(row.b31_60)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-700">{money(row.b61_90)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-slate-700">{money(row.b90_plus)}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums font-bold">{money(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function MethodTable({
  title,
  rows,
  empty
}: {
  title: string;
  rows: Array<{ method: string; amount: number; count: number }>;
  empty: string;
}) {
  const t = useT();
  return (
    <div className="rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <p className="text-xs font-bold text-slate-800">{title}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-xs text-slate-500 text-center">{empty}</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-100">
            <tr>
              <th className="text-left font-bold px-4 py-2">{t('reports.acctMethod')}</th>
              <th className="text-right font-bold px-4 py-2">{t('reports.acctAmount')}</th>
              <th className="text-right font-bold px-4 py-2">#</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.method}>
                <td className="px-4 py-2">{row.method}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{money(row.amount)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CashRowsTable({
  title,
  rows,
  nameHeader,
  empty
}: {
  title: string;
  rows: Array<{ date: string; name: string; method: string; amount: number; ref?: string }>;
  nameHeader: string;
  empty: string;
}) {
  const t = useT();
  return (
    <div className="rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <p className="text-xs font-bold text-slate-800">{title}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-xs text-slate-500 text-center">{empty}</p>
      ) : (
        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="w-full text-sm min-w-[480px]">
            <thead className="text-[10px] uppercase tracking-wide text-slate-500 border-b border-slate-100 sticky top-0 bg-white">
              <tr>
                <th className="text-left font-bold px-3 py-2">{t('reports.acctDate')}</th>
                <th className="text-left font-bold px-3 py-2">{nameHeader}</th>
                <th className="text-left font-bold px-3 py-2">{t('reports.acctMethod')}</th>
                <th className="text-right font-bold px-3 py-2">{t('reports.acctAmount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, i) => (
                <tr key={`${row.date}-${row.name}-${row.ref || i}`}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">{row.date}</td>
                  <td className="px-3 py-2">
                    <p className="font-semibold text-slate-900 truncate max-w-[160px]">{row.name}</p>
                    {row.ref ? <p className="text-[10px] text-slate-500 font-mono">{row.ref}</p> : null}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{row.method}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{money(row.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
