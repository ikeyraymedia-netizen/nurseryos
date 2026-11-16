import { AlertCircle, Bell, ClipboardList, DollarSign, Receipt, Sprout, Truck as TruckIcon } from 'lucide-react';
import { DayRecap, dayKeyOf, dayRecapIsEmpty } from '../lib/dayRecap';
import { useT } from '../lib/i18n';

interface WelcomeBackModalProps {
  nurseryName: string;
  logoSrc: string | null;
  firstName: string;
  recap: DayRecap;
  onContinue: () => void;
}

function money(amount: number) {
  return `$${amount.toFixed(2)}`;
}

function shortDate(dayOrIso: string) {
  const key = dayKeyOf(dayOrIso) || dayOrIso.slice(0, 10);
  const date = new Date(`${key}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dayOrIso;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function WelcomeBackModal({
  nurseryName,
  logoSrc,
  firstName,
  recap,
  onContinue
}: WelcomeBackModalProps) {
  const t = useT();
  const greeting = firstName
    ? t('welcomeBack.greeting', { name: firstName })
    : t('welcomeBack.greetingNoName');

  return (
    <div className="fixed inset-0 z-[70] bg-slate-900/45 flex items-center justify-center p-4 lg:p-5">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col lg:max-w-none lg:h-full lg:rounded-2xl">
        <div className="px-6 pt-7 pb-5 text-center border-b border-slate-100 lg:flex lg:items-center lg:justify-between lg:text-left lg:gap-6 lg:px-8 lg:py-4">
          <div className="lg:flex lg:items-center lg:gap-4 lg:min-w-0">
            {logoSrc ? (
              <img
                src={logoSrc}
                alt={nurseryName}
                className="mx-auto h-16 w-auto max-w-[200px] object-contain lg:mx-0 lg:h-12"
              />
            ) : (
              <p className="text-lg font-black tracking-tight text-slate-900">{nurseryName}</p>
            )}
            <div className="min-w-0">
              <h2 className="mt-4 text-xl font-black tracking-tight text-slate-900 lg:mt-0">{greeting}</h2>
              <p className="mt-1 text-xs text-slate-500">
                {new Date().toLocaleDateString(undefined, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric'
                })}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onContinue}
            className="hidden lg:inline-flex shrink-0 px-8 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800"
          >
            {t('welcomeBack.continue')}
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto px-5 py-4 space-y-4 lg:max-h-none lg:flex-1 lg:min-h-0 lg:overflow-hidden lg:grid lg:grid-cols-2 lg:auto-rows-fr xl:grid-cols-3 lg:gap-4 lg:space-y-0 lg:px-6 lg:py-5">
          {recap.alerts.length > 0 && (
            <RecapSection
              icon={Bell}
              title={t('welcomeBack.alerts')}
              scroll
              rows={recap.alerts.map((row) => ({
                id: row.id,
                primary: row.title,
                secondary: [
                  t(
                    row.kind === 'order'
                      ? 'welcomeBack.alertOrder'
                      : row.kind === 'plant'
                        ? 'welcomeBack.alertPlant'
                        : row.kind === 'truck'
                          ? 'welcomeBack.alertTruck'
                          : 'welcomeBack.alertInventory'
                  ),
                  row.detail
                    ? row.kind === 'truck'
                      ? shortDate(row.detail)
                      : row.detail
                    : ''
                ]
                  .filter(Boolean)
                  .join(' · ')
              }))}
              extra={0}
            />
          )}
          {recap.showTrucks && (
            <RecapSection
              icon={TruckIcon}
              title={t('welcomeBack.trucks')}
              scroll={recap.trucks.length > 0}
              rows={
                recap.trucks.length > 0
                  ? recap.trucks.map((row) => ({
                      id: row.id,
                      primary: row.name,
                      secondary: [
                        shortDate(row.loadingDate),
                        t(
                          row.status === 'loading'
                            ? 'welcomeBack.loading'
                            : row.status === 'completed'
                              ? 'welcomeBack.out'
                              : 'welcomeBack.scheduled'
                        ),
                        t(
                          row.orderCount === 1
                            ? 'welcomeBack.orderOnTruck'
                            : 'welcomeBack.ordersOnTruck',
                          { n: row.orderCount }
                        )
                      ].join(' · ')
                    }))
                  : [{ id: 'no-trucks', primary: t('welcomeBack.noTrucks'), secondary: '' }]
              }
              extra={0}
            />
          )}
          {recap.showOrders && (
            <RecapSection
              icon={ClipboardList}
              title={t('welcomeBack.orders')}
              scroll={recap.orders.length > 0}
              rows={
                recap.orders.length > 0
                  ? recap.orders.map((row) => ({
                      id: row.id,
                      primary: row.customerName,
                      secondary: [row.orderNumber, shortDate(row.date)].filter(Boolean).join(' · ')
                    }))
                  : [{ id: 'no-orders', primary: t('welcomeBack.noOrders'), secondary: '' }]
              }
              extra={0}
            />
          )}
          {dayRecapIsEmpty(recap) && !recap.showTrucks && !recap.showOrders ? (
            <p className="text-sm text-slate-500 text-center py-4">{t('welcomeBack.quiet')}</p>
          ) : (
            <>
              {recap.payments.length > 0 && (
                <RecapSection
                  icon={DollarSign}
                  title={t('welcomeBack.payments')}
                  scroll
                  rows={recap.payments.map((row) => ({
                    id: row.id,
                    primary: row.customerName,
                    secondary: `${row.documentNumber} · ${money(row.amount)} · ${shortDate(row.paidAt)}`
                  }))}
                  extra={0}
                />
              )}
              {recap.overdue.length > 0 && (
                <RecapSection
                  icon={AlertCircle}
                  title={t('welcomeBack.overdue')}
                  scroll
                  rows={recap.overdue.map((row) => ({
                    id: row.id,
                    primary: row.documentNumber,
                    secondary: `${row.customerName} · ${money(row.amount)} · ${t('welcomeBack.dueOn', { date: shortDate(row.due) })}`
                  }))}
                  extra={0}
                />
              )}
              {recap.bills.some((row) => row.overdue) && (
                <RecapSection
                  icon={Receipt}
                  title={t('welcomeBack.billsOverdue')}
                  scroll
                  rows={recap.bills
                    .filter((row) => row.overdue)
                    .map((row) => ({
                      id: row.id,
                      primary: row.vendorName,
                      secondary: [row.billNumber, money(row.amount), t('welcomeBack.dueOn', { date: shortDate(row.due) })].join(
                        ' · '
                      )
                    }))}
                  extra={0}
                />
              )}
              {recap.unavailable.length > 0 && (
                <RecapSection
                  icon={Sprout}
                  title={t('welcomeBack.unavailable')}
                  scroll
                  rows={recap.unavailable.map((row) => ({
                    id: row.id,
                    primary: row.plantName,
                    secondary: row.containerSize
                  }))}
                  extra={0}
                />
              )}
            </>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-100 lg:hidden">
          <button
            type="button"
            onClick={onContinue}
            className="w-full py-2.5 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800"
          >
            {t('welcomeBack.continue')}
          </button>
        </div>
      </div>
    </div>
  );
}

function RecapSection({
  icon: Icon,
  title,
  rows,
  extra,
  scroll = false
}: {
  icon: typeof DollarSign;
  title: string;
  rows: { id: string; primary: string; secondary: string }[];
  extra: number;
  scroll?: boolean;
}) {
  const t = useT();
  return (
    <section className="lg:h-full lg:min-h-0 lg:overflow-hidden lg:flex lg:flex-col lg:rounded-xl lg:border lg:border-slate-200 lg:p-3">
      <div className="flex items-center gap-2 mb-1.5 shrink-0">
        <Icon className="h-3.5 w-3.5 text-ink-700" />
        <h3 className="text-[10px] font-black uppercase tracking-wider text-ink-700">{title}</h3>
      </div>
      <ul className={`space-y-1.5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1 ${scroll ? 'max-h-40 overflow-y-auto pr-1 lg:max-h-none' : ''}`}>
        {rows.map((row) => (
          <li key={row.id} className="rounded-lg bg-slate-50 px-3 py-2">
            <p className="text-sm font-bold text-slate-900 leading-snug">{row.primary}</p>
            {row.secondary ? (
              <p className="text-xs text-slate-500 leading-snug">{row.secondary}</p>
            ) : null}
          </li>
        ))}
      </ul>
      {extra > 0 && (
        <p className="text-[11px] text-slate-400 mt-1.5 font-semibold">{t('welcomeBack.more', { n: extra })}</p>
      )}
    </section>
  );
}
