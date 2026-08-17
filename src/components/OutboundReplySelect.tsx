import { useEffect, useState } from 'react';
import {
  defaultIdentityEmail,
  fetchEmailStatus,
  identitiesFromStatus,
  type EmailIdentity
} from '../lib/email';
import { useT } from '../lib/i18n';

export function OutboundReplySelect({
  tenantId,
  value,
  onChange,
  disabled
}: {
  tenantId?: string;
  value: string;
  onChange: (email: string, identity: EmailIdentity | null) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [identities, setIdentities] = useState<EmailIdentity[]>([]);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    void fetchEmailStatus(tenantId)
      .then((status) => {
        if (cancelled) return;
        const rows = identitiesFromStatus(status);
        setIdentities(rows);
        const current = value.trim().toLowerCase();
        const stillValid = rows.some((row) => row.fromEmail.toLowerCase() === current);
        if (!stillValid) {
          const fallback = rows.find((row) => row.fromEmail === defaultIdentityEmail(status)) || rows[0];
          onChange(fallback?.fromEmail || '', fallback || null);
        }
      })
      .catch(() => {
        if (!cancelled) setIdentities([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  if (!tenantId || identities.length === 0) return null;

  if (identities.length === 1) {
    const only = identities[0];
    return (
      <p className="text-[10px] text-slate-600 leading-relaxed">
        {t('invoice.replyToFixed', { email: only.fromEmail })}
      </p>
    );
  }

  return (
    <label className="block">
      <span className="block font-bold text-gray-700 font-mono mb-1 uppercase tracking-wider text-[10px]">
        {t('invoice.replyToLabel')}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const email = e.target.value;
          const identity = identities.find((row) => row.fromEmail === email) || null;
          onChange(email, identity);
        }}
        className="w-full px-3 py-1.5 border border-gray-200 rounded-xl focus:outline-none focus:border-ink-500 bg-white font-semibold text-gray-800 text-xs"
      >
        {identities.map((row) => (
          <option key={row.id} value={row.fromEmail}>
            {row.label ? `${row.label} · ${row.fromEmail}` : row.fromEmail}
          </option>
        ))}
      </select>
    </label>
  );
}
