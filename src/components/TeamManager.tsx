import { useEffect, useState } from 'react';
import { Users, Copy, Check, UserPlus, Trash2, KeyRound, Shield, Link2, Unlink, Mail } from 'lucide-react';
import { MemberRole, Tenant, TenantInvite, TenantMember } from '../types';
import {
  createTeamInvite,
  listActiveInvites,
  listTeamMembers,
  removeTeamMember,
  sendMemberPasswordReset,
  updateMemberRoles
} from '../lib/tenants';
import {
  getAssignableRoles,
  getMemberRoles,
  memberHasRole,
  rolesLabel
} from '../lib/permissions';
import { TENANT_MODULE_DEFS, resolveEnabledModules } from '../lib/modules';
import { logAuditEvent } from '../lib/audit';
import {
  disconnectQuickbooks,
  fetchQuickbooksStatus,
  fetchRecentQuickbooksInvoices,
  QuickbooksStatus,
  startQuickbooksConnect
} from '../lib/quickbooks';
import {
  disconnectStripe,
  fetchStripeStatus,
  startStripeConnect,
  StripeStatus
} from '../lib/stripe';
import {
  CheckbookStatus,
  connectCheckbook,
  disconnectCheckbook,
  fetchCheckbookStatus
} from '../lib/checkbook';
import {
  disconnectEmail,
  fetchEmailStatus,
  saveEmailConfig,
  EmailStatus
} from '../lib/email';
import { tenantHasModule } from '../lib/modules';
import { AppLocale, useRoleLabel, useT } from '../lib/i18n';

interface TeamManagerProps {
  tenant: Tenant;
  currentUserId: string;
  locale: AppLocale;
  onUpdateLocale: (locale: AppLocale) => Promise<void>;
  onClose: () => void;
  onMemberUpdated?: (member: TenantMember) => void;
}

const ASSIGNABLE = getAssignableRoles();

export function TeamManager({
  tenant,
  currentUserId,
  locale,
  onUpdateLocale,
  onClose,
  onMemberUpdated
}: TeamManagerProps) {
  const t = useT();
  const { roleLabel } = useRoleLabel();
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [invites, setInvites] = useState<TenantInvite[]>([]);
  const [inviteRoles, setInviteRoles] = useState<Exclude<MemberRole, 'owner'>[]>(['loader']);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [draftRoles, setDraftRoles] = useState<MemberRole[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [qbStatus, setQbStatus] = useState<QuickbooksStatus | null>(null);
  const [qbBusy, setQbBusy] = useState(false);
  const [qbError, setQbError] = useState<string | null>(null);
  const [qbRecent, setQbRecent] = useState<
    Array<{
      id: string;
      docNumber: string | null;
      txnDate: string | null;
      totalAmt: number | null;
      customerName: string | null;
      openUrl: string;
    }>
  >([]);
  const [qbRecentBusy, setQbRecentBusy] = useState(false);
  const [stripeStatus, setStripeStatus] = useState<StripeStatus | null>(null);
  const [stripeBusy, setStripeBusy] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);
  const [checkbookStatus, setCheckbookStatus] = useState<CheckbookStatus | null>(null);
  const [checkbookBusy, setCheckbookBusy] = useState(false);
  const [checkbookError, setCheckbookError] = useState<string | null>(null);
  const [checkbookPubKey, setCheckbookPubKey] = useState('');
  const [checkbookSecret, setCheckbookSecret] = useState('');
  const [checkbookWebhookKey, setCheckbookWebhookKey] = useState('');
  const [checkbookEnv, setCheckbookEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailFromEmail, setEmailFromEmail] = useState('');
  const [emailFromName, setEmailFromName] = useState('');
  const paymentsEnabled = tenantHasModule(tenant, 'payments');
  const quickbooksEnabled = tenantHasModule(tenant, 'quickbooks');
  const billPayEnabled = tenantHasModule(tenant, 'billPay');

  async function refreshEmail() {
    try {
      const status = await fetchEmailStatus(tenant.id);
      setEmailStatus(status);
      setEmailFromEmail(status.fromEmail || '');
      setEmailFromName(status.fromName || tenant.name);
      setEmailError(null);
    } catch (err: any) {
      setEmailStatus(null);
      setEmailError(err?.message || t('teamExtra.loadEmailFailed'));
    }
  }

  async function refresh() {
    const [m, i] = await Promise.all([
      listTeamMembers(tenant.id),
      listActiveInvites(tenant.id)
    ]);
    setMembers(m);
    setInvites(i);
  }

  async function refreshQuickbooks() {
    try {
      const status = await fetchQuickbooksStatus(tenant.id);
      setQbStatus(status);
      setQbError(null);
    } catch (err: any) {
      // Keep configured=true if keys exist; surface the real auth/role/admin error.
      setQbStatus((prev) =>
        prev
          ? { ...prev, connected: false }
          : {
              connected: false,
              realmId: null,
              connectedAt: null,
              environment: 'sandbox',
              configured: true
            }
      );
      setQbError(err?.message || t('teamExtra.loadQbFailed'));
    }
  }

  async function refreshCheckbook() {
    try {
      const status = await fetchCheckbookStatus(tenant.id);
      setCheckbookStatus(status);
      if (status.environment) setCheckbookEnv(status.environment);
      setCheckbookError(null);
    } catch (err: any) {
      setCheckbookStatus(null);
      setCheckbookError(err?.message || t('teamExtra.loadCheckbookFailed'));
    }
  }

  async function refreshStripe() {
    try {
      const status = await fetchStripeStatus(tenant.id);
      setStripeStatus(status);
      setStripeError(null);
    } catch (err: any) {
      setStripeStatus((prev) =>
        prev
          ? { ...prev, connected: false }
          : {
              connected: false,
              accountId: null,
              chargesEnabled: false,
              detailsSubmitted: false,
              payoutsEnabled: false,
              connectedAt: null,
              configured: true
            }
      );
      setStripeError(err?.message || t('teamExtra.loadStripeFailed'));
    }
  }

  useEffect(() => {
    refresh().catch((err) => setError(err?.message || t('teamExtra.loadTeamFailed')));
    void (async () => {
      if (quickbooksEnabled) {
        try {
          const cfg = await fetch('/api/quickbooks/config-status').then((r) => r.json());
          const ready = Boolean(cfg?.configured);
          setQbStatus({
            connected: false,
            realmId: null,
            connectedAt: null,
            environment: cfg?.environment || 'sandbox',
            configured: ready
          });
          if (!ready) {
            if (cfg?.quickbooks && !cfg?.firebaseAdmin) {
              setQbError(
                t('teamExtra.firebaseAdminMissing')
              );
            } else if (!cfg?.quickbooks) {
              setQbError(
                t('teamExtra.qbKeysMissing')
              );
            } else {
              setQbError(t('teamExtra.qbNotConfigured'));
            }
          } else {
            setQbError(null);
            await refreshQuickbooks();
          }
        } catch (err: any) {
          setQbStatus({
            connected: false,
            realmId: null,
            connectedAt: null,
            environment: 'sandbox',
            configured: false
          });
          setQbError(err?.message || t('teamExtra.qbReachFailed'));
        }
      } else {
        setQbStatus(null);
        setQbError(null);
      }

      if (!paymentsEnabled) {
        setStripeStatus(null);
        setStripeError(null);
      } else {
      try {
        const cfg = await fetch('/api/stripe/config-status').then((r) => r.json());
        const ready = Boolean(cfg?.configured);
        setStripeStatus({
          connected: false,
          accountId: null,
          chargesEnabled: false,
          detailsSubmitted: false,
          payoutsEnabled: false,
          connectedAt: null,
          configured: ready
        });
        if (!ready) {
          if (cfg?.stripe && !cfg?.firebaseAdmin) {
            setStripeError(
              t('teamExtra.firebaseAdminMissing')
            );
          } else if (!cfg?.stripe) {
            setStripeError(
              t('teamExtra.stripeKeysMissing')
            );
          } else {
            setStripeError(t('teamExtra.stripeNotConfigured'));
          }
        } else {
          setStripeError(null);
          await refreshStripe();
        }
      } catch (err: any) {
        setStripeStatus({
          connected: false,
          accountId: null,
          chargesEnabled: false,
          detailsSubmitted: false,
          payoutsEnabled: false,
          connectedAt: null,
          configured: false
        });
        setStripeError(err?.message || t('teamExtra.stripeReachFailed'));
      }
      }

      if (billPayEnabled) {
        try {
          await refreshCheckbook();
        } catch {
          // refreshCheckbook sets error state
        }
      } else {
        setCheckbookStatus(null);
        setCheckbookError(null);
      }

      await refreshEmail();
    })();
  }, [tenant.id, paymentsEnabled, quickbooksEnabled, billPayEnabled]);

  async function handleConnectStripe() {
    setStripeBusy(true);
    setStripeError(null);
    setError(null);
    setMessage(null);
    try {
      const { onboardingUrl } = await startStripeConnect(tenant.id);
      void logAuditEvent({
        action: 'stripe.connect_started',
        summary: 'Started Stripe Connect onboarding'
      });
      window.location.href = onboardingUrl;
    } catch (err: any) {
      setStripeError(err?.message || t('teamExtra.stripeConnectFailed'));
    } finally {
      setStripeBusy(false);
    }
  }

  async function handleDisconnectStripe() {
    const ok = confirm(t('teamExtra.disconnectStripe'));
    if (!ok) return;
    setStripeBusy(true);
    setStripeError(null);
    try {
      await disconnectStripe(tenant.id);
      void logAuditEvent({
        action: 'stripe.disconnected',
        summary: 'Disconnected Stripe Connect'
      });
      setMessage(t('teamExtra.stripeDisconnected'));
      await refreshStripe();
    } catch (err: any) {
      setStripeError(err?.message || t('teamExtra.stripeDisconnectFailed'));
    } finally {
      setStripeBusy(false);
    }
  }

  async function handleConnectCheckbook() {
    if (!checkbookPubKey.trim() || !checkbookSecret.trim()) {
      setCheckbookError(t('teamExtra.checkbookKeysRequired'));
      return;
    }
    setCheckbookBusy(true);
    setCheckbookError(null);
    setMessage(null);
    try {
      const status = await connectCheckbook({
        tenantId: tenant.id,
        publishableKey: checkbookPubKey.trim(),
        secretKey: checkbookSecret.trim(),
        ...(checkbookWebhookKey.trim() ? { webhookKey: checkbookWebhookKey.trim() } : {}),
        environment: checkbookEnv
      });
      setCheckbookStatus(status);
      setCheckbookPubKey('');
      setCheckbookSecret('');
      setCheckbookWebhookKey('');
      void logAuditEvent({
        action: 'checkbook.connected',
        summary: `Connected Checkbook (${checkbookEnv})`
      });
      setMessage(t('teamExtra.checkbookConnected'));
    } catch (err: any) {
      setCheckbookError(err?.message || t('teamExtra.checkbookConnectFailed'));
    } finally {
      setCheckbookBusy(false);
    }
  }

  async function handleDisconnectCheckbook() {
    const ok = confirm(t('teamExtra.disconnectCheckbook'));
    if (!ok) return;
    setCheckbookBusy(true);
    setCheckbookError(null);
    try {
      await disconnectCheckbook(tenant.id);
      void logAuditEvent({
        action: 'checkbook.disconnected',
        summary: 'Disconnected Checkbook bill pay'
      });
      setCheckbookStatus(null);
      setMessage(t('teamExtra.checkbookDisconnected'));
    } catch (err: any) {
      setCheckbookError(err?.message || t('teamExtra.checkbookDisconnectFailed'));
    } finally {
      setCheckbookBusy(false);
    }
  }

  async function handleSaveEmail() {
    setEmailBusy(true);
    setEmailError(null);
    setMessage(null);
    try {
      const status = await saveEmailConfig({
        tenantId: tenant.id,
        fromEmail: emailFromEmail.trim(),
        fromName: emailFromName.trim() || tenant.name
      });
      setEmailStatus(status);
      void logAuditEvent({
        action: 'email.configured',
        summary: `Configured outbound email reply-to ${status.fromEmail}`
      });
      setMessage(`Customer replies will go to ${status.fromEmail}.`);
    } catch (err: any) {
      setEmailError(err?.message || t('teamExtra.emailSaveFailed'));
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleDisconnectEmail() {
    const ok = confirm('Remove this nursery’s outbound email settings? Invoice emails will stop until reconfigured.');
    if (!ok) return;
    setEmailBusy(true);
    setEmailError(null);
    try {
      await disconnectEmail(tenant.id);
      setEmailStatus(null);
      void logAuditEvent({
        action: 'email.disconnected',
        summary: 'Disconnected outbound email'
      });
      setMessage(t('teamExtra.emailDisconnected'));
    } catch (err: any) {
      setEmailError(err?.message || t('teamExtra.emailDisconnectFailed'));
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleConnectQuickbooks() {
    setQbBusy(true);
    setQbError(null);
    setError(null);
    setMessage(null);
    try {
      const url = await startQuickbooksConnect(tenant.id);
      void logAuditEvent({
        action: 'quickbooks.connect_started',
        summary: 'Started QuickBooks Online connection'
      }).catch(() => undefined);
      window.location.assign(url);
    } catch (err: any) {
      setQbError(err?.message || t('teamExtra.qbConnectFailed'));
      setQbBusy(false);
    }
  }

  async function handleLoadRecentQbInvoices() {
    setQbRecentBusy(true);
    setQbError(null);
    try {
      const data = await fetchRecentQuickbooksInvoices(tenant.id);
      setQbRecent(data.invoices);
      if (data.companyName) {
        setQbStatus((prev) => (prev ? { ...prev, companyName: data.companyName } : prev));
      }
      if (data.invoices.length === 0) {
        setQbError(
          `No invoices found in connected ${data.environment} company${
            data.companyName ? ` “${data.companyName}”` : ''
          }. Try pushing again after redeploy.`
        );
      }
    } catch (err: any) {
      setQbError(err?.message || t('teamExtra.qbRecentFailed'));
    } finally {
      setQbRecentBusy(false);
    }
  }

  async function handleDisconnectQuickbooks() {
    const ok = confirm(t('teamExtra.qbDisconnectConfirm'));
    if (!ok) return;
    setQbBusy(true);
    setQbError(null);
    setError(null);
    setMessage(null);
    try {
      await disconnectQuickbooks(tenant.id);
      await logAuditEvent({
        action: 'quickbooks.disconnected',
        summary: 'Disconnected QuickBooks Online'
      });
      setMessage(t('teamExtra.qbDisconnected'));
      setQbRecent([]);
      await refreshQuickbooks();
    } catch (err: any) {
      setQbError(err?.message || t('teamExtra.qbDisconnectFailed'));
    } finally {
      setQbBusy(false);
    }
  }

  function toggleInviteRole(role: Exclude<MemberRole, 'owner'>) {
    setInviteRoles((prev) => {
      if (prev.includes(role)) {
        const next = prev.filter((r) => r !== role);
        return next.length ? next : prev;
      }
      return [...prev, role];
    });
  }

  function startEditRoles(member: TenantMember) {
    if (memberHasRole(member, 'owner')) {
      setError(t('teamExtra.ownerRolesLocked'));
      return;
    }
    setEditingUserId(member.userId);
    setDraftRoles(getMemberRoles(member).filter((r) => r !== 'owner'));
    setError(null);
    setMessage(null);
  }

  function toggleDraftRole(role: Exclude<MemberRole, 'owner'>) {
    setDraftRoles((prev) => {
      if (prev.includes(role)) {
        const next = prev.filter((r) => r !== role);
        return next.length ? next : prev;
      }
      return [...prev, role];
    });
  }

  async function handleSaveRoles(member: TenantMember) {
    if (draftRoles.length === 0) {
      setError(t('teamExtra.pickOneRole'));
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await updateMemberRoles({
        tenantId: tenant.id,
        memberUserId: member.userId,
        roles: draftRoles
      });
      await logAuditEvent({
        action: 'team.roles_updated',
        summary: `Updated roles for ${member.displayName || member.email} to ${rolesLabel(draftRoles)}`,
        meta: {
          memberUserId: member.userId,
          roles: draftRoles
        }
      });
      setEditingUserId(null);
      setMessage(`Roles updated for ${member.displayName || member.email}.`);
      await refresh();
      if (member.userId === currentUserId) {
        onMemberUpdated?.(updated);
      }
    } catch (err: any) {
      setError(err?.message || t('teamExtra.rolesUpdateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateInvite() {
    if (inviteRoles.length === 0) {
      setError(t('teamExtra.pickInviteRole'));
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const invite = await createTeamInvite({
        tenantId: tenant.id,
        tenantName: tenant.name,
        roles: inviteRoles,
        createdBy: currentUserId
      });
      await refresh();
      await navigator.clipboard.writeText(invite.code);
      setCopiedCode(invite.code);
      setTimeout(() => setCopiedCode(null), 2000);
      setMessage(`Invite created for ${rolesLabel(inviteRoles)}.`);
    } catch (err: any) {
      setError(err?.message || t('teamExtra.inviteFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveMember(member: TenantMember) {
    if (member.userId === currentUserId) {
      setError(t('teamExtra.cannotRemoveSelf'));
      return;
    }
    if (memberHasRole(member, 'owner')) {
      setError(t('teamExtra.ownerCannotRemove'));
      return;
    }
    const ok = confirm(`Remove ${member.displayName || member.email} from this nursery?`);
    if (!ok) return;

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await removeTeamMember({
        tenantId: tenant.id,
        memberUserId: member.userId,
        memberRole: member.role,
        memberRoles: member.roles
      });
      await refresh();
    } catch (err: any) {
      setError(err?.message || t('teamExtra.removeMemberFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword(member: TenantMember) {
    if (!member.email) {
      setError(t('teamExtra.noEmailOnFile'));
      return;
    }
    const label = member.displayName || member.email;
    const ok = window.confirm(
      `Send a password reset email to ${label} (${member.email})?\n\nThey will choose a new password from the link. You will not see their password.`
    );
    if (!ok) return;

    setBusy(true);
    setResettingUserId(member.userId);
    setError(null);
    setMessage(null);
    try {
      await sendMemberPasswordReset(member.email);
      await logAuditEvent({
        action: 'team.password_reset_sent',
        summary: `Password reset email sent to ${member.email}`,
        meta: {
          memberUserId: member.userId,
          memberEmail: member.email,
          roles: rolesLabel(getMemberRoles(member))
        }
      });
      setMessage(`Reset email sent to ${member.email}. Ask them to check inbox/spam.`);
    } catch (err: any) {
      setError(err?.message || t('teamExtra.passwordResetFailed'));
    } finally {
      setBusy(false);
      setResettingUserId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-ink-700" />
            <h3 className="font-bold text-gray-900">{t('teamExtra.title')}</h3>
          </div>
          <button type="button" onClick={onClose} className="text-xs font-bold text-gray-500">
            Close
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <div className="rounded-xl border border-ink-100 bg-ink-50/50 px-3 py-3">
            <p className="text-xs font-bold uppercase text-ink-800">{t('team.languageTitle')}</p>
            <p className="text-[11px] text-gray-600 mb-2">{t('language.hint')}</p>
            <select
              value={locale}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value as AppLocale;
                setBusy(true);
                setError(null);
                void onUpdateLocale(next)
                  .then(() => setMessage(t('team.languageSaved')))
                  .catch(() => setError(t('team.languageFailed')))
                  .finally(() => setBusy(false));
              }}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white"
            >
              <option value="en">{t('language.english')}</option>
              <option value="es">{t('language.spanish')}</option>
            </select>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-xs font-bold uppercase text-gray-500 mb-1">{t('teamExtra.workspacePackage')}</p>
            <p className="text-[11px] text-gray-600 mb-2">
              Workspaces are enabled by NurseryOS in the seller console.
              {tenant.modules == null
                ? ' This nursery is on a legacy plan (all standard modules).'
                : tenant.modules.length === 0
                  ? ' This nursery is not activated yet.'
                  : ''}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {TENANT_MODULE_DEFS.map((mod) => {
                const on = resolveEnabledModules(tenant).has(mod.id);
                return (
                  <span
                    key={mod.id}
                    className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${
                      on
                        ? 'bg-ink-50 text-ink-900 border-ink-200'
                        : 'bg-white text-slate-400 border-slate-200'
                    }`}
                  >
                    {mod.label}
                    {on ? '' : ' · off'}
                  </span>
                );
              })}
            </div>
          </div>

          {quickbooksEnabled && (
          <div className="rounded-xl border border-sky-100 bg-sky-50/50 px-3 py-3 space-y-2">
            <p className="text-xs font-bold uppercase text-sky-900">{t('teamExtra.qbo')}</p>
            <p className="text-[11px] text-sky-950/80 leading-relaxed">
              Connect this nursery to push saved invoices and estimates into QuickBooks.
              Owner/admin only.
            </p>
            {qbStatus?.connected ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-ink-800">
                  Connected
                  {qbStatus.connectedAt
                    ? ` · ${new Date(qbStatus.connectedAt).toLocaleDateString()}`
                    : ''}
                  {qbStatus.environment ? ` · ${qbStatus.environment}` : ''}
                </p>
                {qbStatus.companyName && (
                  <p className="text-[11px] text-sky-950/80">
                    Company: <span className="font-semibold">{qbStatus.companyName}</span>
                  </p>
                )}
                {qbStatus.environment === 'sandbox' && (
                  <p className="text-[11px] text-amber-800 leading-relaxed">
                    Invoices go to{' '}
                    <a
                      className="underline font-semibold"
                      href="https://app.sandbox.qbo.intuit.com/app/invoices"
                      target="_blank"
                      rel="noreferrer"
                    >
                      sandbox QuickBooks
                    </a>
                    , not your live company. Company name in sandbox must match what’s shown above.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={qbBusy || busy}
                    onClick={() => void handleDisconnectQuickbooks()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-bold disabled:opacity-50"
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    Disconnect
                  </button>
                  <button
                    type="button"
                    disabled={qbRecentBusy || busy}
                    onClick={() => void handleLoadRecentQbInvoices()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-sky-200 bg-white text-sky-800 text-xs font-bold disabled:opacity-50"
                  >
                    {qbRecentBusy ? t('common.loading') : t('teamExtra.showQbo')}
                  </button>
                </div>
                {qbRecent.length > 0 && (
                  <div className="rounded-lg border border-sky-100 bg-white px-2.5 py-2 space-y-1.5">
                    <p className="text-[10px] font-bold uppercase text-sky-900">
                      Latest in connected company
                    </p>
                    {qbRecent.map((inv) => (
                      <a
                        key={inv.id}
                        href={inv.openUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block text-[11px] text-sky-900 hover:underline"
                      >
                        {inv.docNumber ? `#${inv.docNumber}` : `Id ${inv.id}`}
                        {inv.customerName ? ` · ${inv.customerName}` : ''}
                        {inv.totalAmt != null ? ` · $${inv.totalAmt.toFixed(2)}` : ''}
                        {inv.txnDate ? ` · ${inv.txnDate}` : ''}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                disabled={qbBusy || busy || qbStatus?.configured === false}
                onClick={() => void handleConnectQuickbooks()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-sky-700 text-white text-xs font-bold disabled:opacity-50"
                title={
                  qbStatus?.configured === false
                    ? 'Add QuickBooks and Firebase Admin env vars on the server first'
                    : 'Connect QuickBooks'
                }
              >
                <Link2 className="h-3.5 w-3.5" />
                {qbBusy ? t('teamExtra.openingQbo') : t('teamExtra.connectQbo')}
              </button>
            )}
            {qbError && <p className="text-[11px] text-red-700 leading-relaxed">{qbError}</p>}
            {qbStatus && !qbStatus.configured && !qbError && (
              <p className="text-[11px] text-amber-800">
                Server keys not set yet. Add QUICKBOOKS_CLIENT_ID / SECRET and
                FIREBASE_SERVICE_ACCOUNT_BASE64 in Railway, then refresh.
              </p>
            )}
          </div>
          )}

          {paymentsEnabled && (
            <div className="rounded-xl border border-violet-100 bg-violet-50/50 px-3 py-3 space-y-2">
              <p className="text-xs font-bold uppercase text-violet-900">{t('teamExtra.stripe')}</p>
              <p className="text-[11px] text-violet-950/80 leading-relaxed">
                Connect this nursery’s Stripe account so customers can pay invoices by card. Funds
                go to the nursery (merchant of record). Owner/admin only.
              </p>
              {stripeStatus?.connected ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-ink-800">
                    {stripeStatus.chargesEnabled
                      ? t('teamExtra.stripeReady')
                      : t('teamExtra.stripeConnectedPartial')}
                    {stripeStatus.connectedAt
                      ? ` · ${new Date(stripeStatus.connectedAt).toLocaleDateString()}`
                      : ''}
                  </p>
                  {stripeStatus.accountId && (
                    <p className="text-[11px] text-violet-950/80 font-mono truncate">
                      {stripeStatus.accountId}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {!stripeStatus.chargesEnabled && (
                      <button
                        type="button"
                        disabled={stripeBusy || busy}
                        onClick={() => void handleConnectStripe()}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-700 text-white text-xs font-bold disabled:opacity-50"
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        {stripeBusy ? 'Opening Stripe…' : 'Continue onboarding'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={stripeBusy || busy}
                      onClick={() => void handleDisconnectStripe()}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-bold disabled:opacity-50"
                    >
                      <Unlink className="h-3.5 w-3.5" />
                      Disconnect
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={stripeBusy || busy || stripeStatus?.configured === false}
                  onClick={() => void handleConnectStripe()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-700 text-white text-xs font-bold disabled:opacity-50"
                  title={
                    stripeStatus?.configured === false
                      ? 'Add Stripe and Firebase Admin env vars on the server first'
                      : 'Connect Stripe'
                  }
                >
                  <Link2 className="h-3.5 w-3.5" />
                  {stripeBusy ? t('teamExtra.openingStripe') : t('teamExtra.connectStripe')}
                </button>
              )}
              {stripeError && (
                <p className="text-[11px] text-red-700 leading-relaxed">{stripeError}</p>
              )}
            </div>
          )}

          {billPayEnabled && (
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 px-3 py-3 space-y-2">
              <p className="text-xs font-bold uppercase text-emerald-900">{t('teamExtra.checkbook')}</p>
              <p className="text-[11px] text-emerald-950/80 leading-relaxed">
                {t('teamExtra.checkbookIntro')}
              </p>
              <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-2 py-1.5 leading-relaxed">
                Use keys from Checkbook <span className="font-bold">Settings → Developer</span> with
                the environment toggle set to <span className="font-bold">Sandbox</span>. Production
                keys will fail here. Webhook key is optional.
              </p>
              {checkbookStatus?.connected ? (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-ink-800">
                    {t('teamExtra.checkbookConnectedStatus', {
                      env: checkbookStatus.environment || 'sandbox',
                      last4: checkbookStatus.publishableKeyLast4 || '····'
                    })}
                  </p>
                  <p className="text-[11px] text-emerald-950/80 break-all">
                    {t('teamExtra.checkbookWebhookHint')}{' '}
                    <span className="font-mono">{checkbookStatus.webhookUrl}</span>
                  </p>
                  <button
                    type="button"
                    disabled={checkbookBusy || busy}
                    onClick={() => void handleDisconnectCheckbook()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-bold disabled:opacity-50"
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    {t('teamExtra.disconnect')}
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="block text-[11px] font-bold text-emerald-950">
                    {t('teamExtra.checkbookEnvironment')}
                    <select
                      value={checkbookEnv}
                      onChange={(e) =>
                        setCheckbookEnv(e.target.value === 'production' ? 'production' : 'sandbox')
                      }
                      className="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-emerald-200 bg-white text-xs"
                    >
                      <option value="sandbox">Sandbox (api.sandbox.checkbook.io)</option>
                      <option value="production">Production (api.checkbook.io)</option>
                    </select>
                  </label>
                  <input
                    value={checkbookPubKey}
                    onChange={(e) => setCheckbookPubKey(e.target.value)}
                    placeholder={t('teamExtra.checkbookPublishable')}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-emerald-200 bg-white text-xs"
                    autoComplete="off"
                  />
                  <input
                    type="password"
                    value={checkbookSecret}
                    onChange={(e) => setCheckbookSecret(e.target.value)}
                    placeholder={t('teamExtra.checkbookSecret')}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-emerald-200 bg-white text-xs"
                    autoComplete="off"
                  />
                  <input
                    value={checkbookWebhookKey}
                    onChange={(e) => setCheckbookWebhookKey(e.target.value)}
                    placeholder={t('teamExtra.checkbookWebhookKey')}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-emerald-200 bg-white text-xs"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    disabled={checkbookBusy || busy}
                    onClick={() => void handleConnectCheckbook()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700 text-white text-xs font-bold disabled:opacity-50"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    {checkbookBusy ? t('common.pleaseWait') : t('teamExtra.connectCheckbook')}
                  </button>
                </div>
              )}
              {checkbookError && (
                <p className="text-[11px] text-red-700 leading-relaxed">{checkbookError}</p>
              )}
            </div>
          )}

          <div className="rounded-xl border border-ink-100 bg-ink-50/40 px-3 py-3 space-y-2">
            <p className="text-xs font-bold uppercase text-ink-900 flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              Outbound email
            </p>
            <p className="text-[11px] text-ink-950/80 leading-relaxed">
              Invoices are sent through NurseryOS email (Resend). Set this nursery’s display name
              and reply-to address so customers can answer the nursery, not the platform. Owner/admin
              only.
            </p>
            {emailStatus?.configured ? (
              <p className="text-xs font-semibold text-ink-800">
                Reply-to {emailStatus.fromEmail}
                {emailStatus.configuredAt
                  ? ` · saved ${new Date(emailStatus.configuredAt).toLocaleDateString()}`
                  : ''}
              </p>
            ) : (
              <p className="text-xs font-semibold text-amber-800">{t('teamExtra.notConfigured')}</p>
            )}
            {emailStatus && emailStatus.platformReady === false && (
              <p className="text-[11px] text-amber-800 leading-relaxed">
                Platform email is not ready yet — add <code>RESEND_API_KEY</code> in Railway.
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-900/70">
                From name
                <input
                  type="text"
                  value={emailFromName}
                  onChange={(e) => setEmailFromName(e.target.value)}
                  placeholder={tenant.name}
                  className="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-ink-200 bg-white text-xs font-semibold text-slate-800"
                />
              </label>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-ink-900/70">
                Reply-to email
                <input
                  type="email"
                  value={emailFromEmail}
                  onChange={(e) => setEmailFromEmail(e.target.value)}
                  placeholder="billing@yournursery.com"
                  className="mt-1 w-full px-2.5 py-1.5 rounded-lg border border-ink-200 bg-white text-xs font-semibold text-slate-800"
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={emailBusy || busy || !emailFromEmail.trim()}
                onClick={() => void handleSaveEmail()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-ink-800 text-white text-xs font-bold disabled:opacity-50"
              >
                {emailBusy ? t('teamExtra.savingEmail') : emailStatus?.configured ? t('teamExtra.updateEmail') : t('teamExtra.saveEmail')}
              </button>
              {emailStatus?.configured && (
                <button
                  type="button"
                  disabled={emailBusy || busy}
                  onClick={() => void handleDisconnectEmail()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-bold disabled:opacity-50"
                >
                  <Unlink className="h-3.5 w-3.5" />
                  Disconnect
                </button>
              )}
            </div>
            {emailError && (
              <p className="text-[11px] text-red-700 leading-relaxed">{emailError}</p>
            )}
          </div>

          <div>
            <p className="text-xs font-bold uppercase text-gray-500 mb-2">{t('teamExtra.currentMembers')}</p>
            <p className="text-[11px] text-gray-500 mb-2 leading-relaxed">
              People can hold more than one role (for example Inventory + Loader). Use Edit roles to
              change access. Password resets are owner/admin only.
            </p>
            <div className="space-y-2">
              {members.map((m) => {
                const roles = getMemberRoles(m);
                const isOwner = memberHasRole(m, 'owner');
                const isEditing = editingUserId === m.userId;
                return (
                  <div
                    key={m.userId}
                    className="rounded-xl border border-gray-100 px-3 py-2.5 space-y-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-gray-900 truncate">
                          {m.displayName || m.email}
                        </p>
                        <p className="text-xs text-gray-500 truncate">{m.email}</p>
                      </div>
                      <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
                        {!isEditing &&
                          roles.map((role) => (
                            <span
                              key={role}
                              className="text-[10px] font-bold uppercase tracking-wide bg-ink-50 text-ink-800 px-2 py-1 rounded-full"
                            >
                              {roleLabel(role)}
                            </span>
                          ))}
                      </div>
                    </div>

                    {isEditing ? (
                      <div className="rounded-lg border border-ink-100 bg-ink-50/50 p-2.5 space-y-2">
                        <p className="text-[10px] font-bold uppercase text-ink-800">
                          Assign roles
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {ASSIGNABLE.map((role) => {
                            const on = draftRoles.includes(role);
                            return (
                              <button
                                key={role}
                                type="button"
                                disabled={busy}
                                onClick={() => toggleDraftRole(role)}
                                className={`text-[11px] font-bold px-2.5 py-1.5 rounded-lg border transition-colors ${
                                  on
                                    ? 'bg-ink-700 text-white border-ink-800'
                                    : 'bg-white text-slate-600 border-slate-200 hover:border-ink-300'
                                }`}
                              >
                                {roleLabel(role)}
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleSaveRoles(m)}
                            className="flex-1 px-2.5 py-1.5 rounded-lg bg-ink-700 text-white text-[11px] font-bold disabled:opacity-50"
                          >
                            Save roles
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setEditingUserId(null)}
                            className="px-2.5 py-1.5 rounded-lg border border-slate-200 text-[11px] font-bold text-slate-600"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {!isOwner && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => startEditRoles(m)}
                            className="inline-flex items-center gap-1 rounded-md border border-ink-200 bg-ink-50 px-2 py-1 text-[10px] font-bold text-ink-800 hover:bg-ink-100 disabled:opacity-50"
                            title={t('teamExtra.editRoles')}
                          >
                            <Shield className="h-3.5 w-3.5" />
                            Edit roles
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busy || !m.email}
                          onClick={() => void handleResetPassword(m)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          title={t('teamExtra.resetPasswordTitle')}
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          {resettingUserId === m.userId ? t('teamExtra.sending') : t('teamExtra.resetPassword')}
                        </button>
                        {m.userId !== currentUserId && !isOwner && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRemoveMember(m)}
                            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-bold text-red-700 hover:bg-red-100 disabled:opacity-50"
                            title={t('teamExtra.removeMemberTitle')}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-4">
            <p className="text-xs font-bold uppercase text-ink-800 mb-2">{t('teamExtra.inviteMember')}</p>
            <p className="text-xs text-ink-900/80 mb-3">
              Select one or more roles for the invite. Office gets customers, invoices, and reports
              (no yard tabs). Sales gets customers, orders, trucks, and invoices, with inventory
              view-only and no tasks. Supervisor runs trucks without pricing. Inventory is plant stock
              only. Example: Inventory + Loader for stock plus truck checkoff.
            </p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {ASSIGNABLE.map((role) => {
                const on = inviteRoles.includes(role);
                return (
                  <button
                    key={role}
                    type="button"
                    disabled={busy}
                    onClick={() => toggleInviteRole(role)}
                    className={`text-[11px] font-bold px-2.5 py-1.5 rounded-lg border transition-colors ${
                      on
                        ? 'bg-ink-700 text-white border-ink-800'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-ink-300'
                    }`}
                  >
                    {roleLabel(role)}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              disabled={busy || inviteRoles.length === 0}
              onClick={() => void handleCreateInvite()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
            >
              <UserPlus className="h-4 w-4" />
              Create invite ({rolesLabel(inviteRoles)})
            </button>
            {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
            {message && <p className="text-xs text-ink-800 font-semibold mt-2">{message}</p>}
          </div>

          {invites.length > 0 && (
            <div>
              <p className="text-xs font-bold uppercase text-gray-500 mb-2">Active invite codes</p>
              <div className="space-y-2">
                {invites.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between rounded-xl border border-gray-100 px-3 py-2"
                  >
                    <div>
                      <p className="font-mono font-bold text-sm">{inv.code}</p>
                      <p className="text-xs text-gray-500">
                        {rolesLabel(inv.roles?.length ? inv.roles : [inv.role])} invite
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(inv.code);
                        setCopiedCode(inv.code);
                        setTimeout(() => setCopiedCode(null), 2000);
                      }}
                      className="inline-flex items-center gap-1 text-xs font-bold text-ink-700"
                    >
                      {copiedCode === inv.code ? (
                        <>
                          <Check className="h-3.5 w-3.5" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" /> Copy
                        </>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
