import { useEffect, useState } from 'react';
import { Users, Copy, Check, UserPlus, Trash2, KeyRound, Shield, Link2, Unlink, Mail, Weight, Plus, Bell } from 'lucide-react';
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
  enableStripeTreasury,
  fetchStripeStatus,
  sandboxOnboardTreasury,
  startStripeConnect,
  StripeStatus
} from '../lib/stripe';
import {
  disconnectEmail,
  fetchEmailStatus,
  identitiesFromStatus,
  saveEmailConfig,
  EmailIdentity,
  EmailStatus
} from '../lib/email';
import { tenantHasModule } from '../lib/modules';
import { AppLocale, useRoleLabel, useT } from '../lib/i18n';
import {
  disablePushNotifications,
  enablePushNotifications,
  isPushConfigured,
  isPushEnabledLocally,
  pushPermissionState
} from '../lib/pushNotifications';

interface TeamManagerProps {
  tenant: Tenant;
  currentUserId: string;
  locale: AppLocale;
  onUpdateLocale: (locale: AppLocale) => Promise<void>;
  onClose: () => void;
  onMemberUpdated?: (member: TenantMember) => void;
  /** Optional — opens container weight defaults (owner/admin). */
  onOpenWeights?: () => void;
}

const ASSIGNABLE = getAssignableRoles();

export function TeamManager({
  tenant,
  currentUserId,
  locale,
  onUpdateLocale,
  onClose,
  onMemberUpdated,
  onOpenWeights
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
  const [pushBusy, setPushBusy] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(() => isPushEnabledLocally());
  const [pushPermission, setPushPermission] = useState(() => pushPermissionState());
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
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailIdentities, setEmailIdentities] = useState<EmailIdentity[]>([]);
  const [emailDefaultId, setEmailDefaultId] = useState('');
  const [newEmailLabel, setNewEmailLabel] = useState('');
  const [newEmailFromName, setNewEmailFromName] = useState('');
  const [newEmailAddress, setNewEmailAddress] = useState('');
  const paymentsEnabled = tenantHasModule(tenant, 'payments');
  const quickbooksEnabled = tenantHasModule(tenant, 'quickbooks');

  async function refreshEmail() {
    try {
      const status = await fetchEmailStatus(tenant.id);
      setEmailStatus(status);
      const rows = identitiesFromStatus(status);
      setEmailIdentities(rows);
      setEmailDefaultId(status.defaultIdentityId || rows[0]?.id || '');
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
          configured: ready,
          testMode: Boolean(cfg?.testMode)
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

      await refreshEmail();
    })();
  }, [tenant.id, paymentsEnabled, quickbooksEnabled]);

  async function handleConnectStripe() {
    setStripeBusy(true);
    setStripeError(null);
    setError(null);
    setMessage(null);
    try {
      const result = await startStripeConnect(tenant.id);
      void logAuditEvent({
        action: 'stripe.connect_started',
        summary: result.chargesEnabled
          ? 'Connected Stripe sandbox account'
          : 'Started Stripe Connect onboarding'
      });
      if (result.chargesEnabled || !result.onboardingUrl) {
        setMessage(t('teamExtra.stripeSandboxReady'));
        await refreshStripe();
        return;
      }
      window.location.href = result.onboardingUrl;
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

  async function handleEnableTreasury() {
    setStripeBusy(true);
    setStripeError(null);
    setError(null);
    setMessage(null);
    try {
      const result = await enableStripeTreasury(tenant.id);
      void logAuditEvent({
        action: 'stripe.treasury_enable_started',
        summary: result.treasuryReady
          ? 'Stripe Treasury financial account ready'
          : 'Started Stripe Treasury onboarding'
      });
      if (result.onboardingUrl) {
        window.location.href = result.onboardingUrl;
        return;
      }
      setMessage(
        result.treasuryReady
          ? t('teamExtra.treasuryReady')
          : t('teamExtra.treasuryPending')
      );
      await refreshStripe();
    } catch (err: any) {
      setStripeError(err?.message || t('teamExtra.treasuryEnableFailed'));
    } finally {
      setStripeBusy(false);
    }
  }

  async function handleSandboxOnboardTreasury() {
    const ok = confirm(t('teamExtra.sandboxOnboardConfirm'));
    if (!ok) return;
    setStripeBusy(true);
    setStripeError(null);
    setError(null);
    setMessage(null);
    try {
      const result = await sandboxOnboardTreasury(tenant.id);
      void logAuditEvent({
        action: 'stripe.sandbox_treasury_onboarded',
        summary: 'Onboarded sandbox nursery with Stripe Treasury'
      });
      setMessage(
        result.treasuryReady
          ? t('teamExtra.sandboxOnboardSuccess', {
              funded: ((result.fundedCents || 0) / 100).toFixed(0)
            })
          : t('teamExtra.treasuryPending')
      );
      await refreshStripe();
    } catch (err: any) {
      setStripeError(err?.message || t('teamExtra.sandboxOnboardFailed'));
    } finally {
      setStripeBusy(false);
    }
  }

  function looksLikeEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function handleAddEmailIdentity() {
    const fromEmail = newEmailAddress.trim().toLowerCase();
    if (!looksLikeEmail(fromEmail)) {
      setEmailError('Enter a valid reply-to email address.');
      return;
    }
    if (emailIdentities.some((row) => row.fromEmail.toLowerCase() === fromEmail)) {
      setEmailError('That reply-to address is already on the list.');
      return;
    }
    const id = `email_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const fromName = newEmailFromName.trim() || tenant.name;
    const label = newEmailLabel.trim() || fromName;
    setEmailIdentities((prev) => [...prev, { id, label, fromName, fromEmail }]);
    if (!emailDefaultId) setEmailDefaultId(id);
    setNewEmailLabel('');
    setNewEmailFromName('');
    setNewEmailAddress('');
    setEmailError(null);
  }

  async function handleSaveEmail() {
    setEmailBusy(true);
    setEmailError(null);
    setMessage(null);
    try {
      const identities = [...emailIdentities];
      if (looksLikeEmail(newEmailAddress.trim())) {
        const fromEmail = newEmailAddress.trim().toLowerCase();
        if (!identities.some((row) => row.fromEmail.toLowerCase() === fromEmail)) {
          identities.push({
            id: `email_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            label: newEmailLabel.trim() || newEmailFromName.trim() || tenant.name,
            fromName: newEmailFromName.trim() || tenant.name,
            fromEmail
          });
        }
      }
      const valid = identities.filter((row) => looksLikeEmail(row.fromEmail));
      if (!valid.length) {
        setEmailError('Add at least one valid reply-to email address.');
        setEmailBusy(false);
        return;
      }
      const status = await saveEmailConfig({
        tenantId: tenant.id,
        identities: valid,
        defaultIdentityId: emailDefaultId || valid[0].id
      });
      setEmailStatus(status);
      const rows = identitiesFromStatus(status);
      setEmailIdentities(rows);
      setEmailDefaultId(status.defaultIdentityId || rows[0]?.id || '');
      void logAuditEvent({
        action: 'email.configured',
        summary: `Configured outbound email (${rows.length}) default ${status.fromEmail}`
      });
      setMessage(`Customer replies will go to ${status.fromEmail} unless another address is chosen when sending.`);
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
      setEmailIdentities([]);
      setEmailDefaultId('');
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

          <div className="rounded-xl border border-ink-100 bg-ink-50/50 px-3 py-3">
            <p className="text-xs font-bold uppercase text-ink-800 flex items-center gap-1.5">
              <Bell className="h-3.5 w-3.5" />
              {t('teamExtra.pushNotifications')}
            </p>
            <p className="text-[11px] text-gray-600 mb-2 leading-relaxed">{t('teamExtra.pushNotificationsHint')}</p>
            {!isPushConfigured() ? (
              <p className="text-[11px] text-amber-700">{t('teamExtra.pushNotConfigured')}</p>
            ) : pushPermission === 'unsupported' ? (
              <p className="text-[11px] text-gray-500">{t('teamExtra.pushUnsupported')}</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                {pushEnabled && pushPermission === 'granted' ? (
                  <>
                    <span className="text-[11px] text-emerald-700 font-medium">{t('teamExtra.pushEnabled')}</span>
                    <button
                      type="button"
                      disabled={pushBusy || busy}
                      onClick={() => {
                        setPushBusy(true);
                        setError(null);
                        void disablePushNotifications()
                          .then(() => {
                            setPushEnabled(false);
                            setMessage(t('teamExtra.pushDisable'));
                          })
                          .catch(() => setError(t('teamExtra.pushDisableFailed')))
                          .finally(() => setPushBusy(false));
                      }}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {t('teamExtra.pushDisable')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={pushBusy || busy}
                    onClick={() => {
                      setPushBusy(true);
                      setError(null);
                      void enablePushNotifications()
                        .then((result) => {
                          setPushPermission(pushPermissionState());
                          if (result === 'granted') {
                            setPushEnabled(true);
                            setMessage(t('teamExtra.pushEnabled'));
                          } else if (result === 'denied') {
                            setPushEnabled(false);
                            setError(t('teamExtra.pushDenied'));
                          } else {
                            setError(t('teamExtra.pushUnsupported'));
                          }
                        })
                        .catch(() => setError(t('teamExtra.pushEnableFailed')))
                        .finally(() => setPushBusy(false));
                    }}
                    className="rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white px-3 py-1.5 text-[11px] font-semibold disabled:opacity-50"
                  >
                    {t('teamExtra.pushEnable')}
                  </button>
                )}
                {pushPermission === 'denied' && !pushEnabled ? (
                  <span className="text-[11px] text-amber-700">{t('teamExtra.pushDenied')}</span>
                ) : null}
              </div>
            )}
          </div>

          {onOpenWeights && (
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
              <p className="text-xs font-bold uppercase text-slate-500">{t('teamExtra.containerWeights')}</p>
              <p className="text-[11px] text-gray-500 mt-0.5 mb-2 leading-relaxed">
                {t('teamExtra.containerWeightsHint')}
              </p>
              <button
                type="button"
                onClick={onOpenWeights}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 px-3 py-1.5 text-[11px] font-semibold text-slate-700"
              >
                <Weight className="h-3.5 w-3.5 text-slate-500" />
                {t('teamExtra.editWeights')}
              </button>
            </div>
          )}

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
                {t('teamExtra.stripeIntro')}
              </p>
              {stripeStatus?.testMode && (
                <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-2 leading-relaxed">
                  {t('teamExtra.stripeSandboxEinHint')}
                </p>
              )}
              {stripeStatus?.testMode && stripeStatus.platformAccountId && (
                <p className="text-[11px] text-violet-950/80 font-mono leading-relaxed break-all">
                  {t('teamExtra.stripePlatformKey', {
                    name: stripeStatus.platformAccountName || 'Stripe',
                    id: stripeStatus.platformAccountId,
                    key: stripeStatus.platformKeyHint || 'sk_test_…'
                  })}
                </p>
              )}
              {stripeStatus?.testMode && stripeStatus.treasuryPlatformAccess === false && (
                <div className="text-[11px] text-rose-950 bg-rose-50 border border-rose-100 rounded-lg px-2.5 py-2 leading-relaxed space-y-1.5">
                  <p className="font-bold">{t('teamExtra.treasuryPlatformBlockedTitle')}</p>
                  <p>{t('teamExtra.treasuryPlatformBlockedBody')}</p>
                  <p className="font-semibold">
                    {t('teamExtra.treasuryPlatformBlockedMatch', {
                      id: stripeStatus.platformAccountId || 'acct_…'
                    })}
                  </p>
                  <a
                    href={
                      stripeStatus.treasuryActivateUrl ||
                      'https://dashboard.stripe.com/setup/treasury/activate'
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex font-bold text-rose-800 underline"
                  >
                    {t('teamExtra.treasuryActivateLink')}
                  </a>
                </div>
              )}
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
                  <p className="text-[11px] text-violet-950/80 leading-relaxed">
                    {stripeStatus.treasuryReady
                      ? t('teamExtra.treasuryReady')
                      : stripeStatus.accountKind === 'express'
                        ? t('teamExtra.treasuryNeedsReconnect')
                        : stripeStatus.treasuryCapability === 'active'
                          ? t('teamExtra.treasuryPending')
                          : t('teamExtra.treasuryNotEnabled')}
                  </p>
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
                    {stripeStatus.testMode && (
                      <button
                        type="button"
                        disabled={stripeBusy || busy}
                        onClick={() => void handleSandboxOnboardTreasury()}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700 text-white text-xs font-bold disabled:opacity-50"
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        {stripeBusy
                          ? t('teamExtra.openingStripe')
                          : t('teamExtra.sandboxOnboardTreasury')}
                      </button>
                    )}
                    {!stripeStatus.treasuryReady &&
                      !stripeStatus.testMode &&
                      stripeStatus.accountKind !== 'express' && (
                      <button
                        type="button"
                        disabled={stripeBusy || busy}
                        onClick={() => void handleEnableTreasury()}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-violet-700 text-white text-xs font-bold disabled:opacity-50"
                      >
                        <Link2 className="h-3.5 w-3.5" />
                        {stripeBusy
                          ? t('teamExtra.openingStripe')
                          : t('teamExtra.enableTreasury')}
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
                <div className="space-y-2">
                  {stripeStatus?.testMode && (
                    <button
                      type="button"
                      disabled={stripeBusy || busy || stripeStatus?.configured === false}
                      onClick={() => void handleSandboxOnboardTreasury()}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700 text-white text-xs font-bold disabled:opacity-50"
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      {stripeBusy
                        ? t('teamExtra.openingStripe')
                        : t('teamExtra.sandboxOnboardTreasury')}
                    </button>
                  )}
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
                </div>
              )}
              {stripeError && (
                <p className="text-[11px] text-red-700 leading-relaxed whitespace-pre-wrap break-words">
                  {stripeError}
                </p>
              )}
            </div>
          )}

          <div className="rounded-xl border border-ink-100 bg-ink-50/40 px-3 py-3 space-y-2">
            <p className="text-xs font-bold uppercase text-ink-900 flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              {t('teamExtra.outboundEmail')}
            </p>
            <p className="text-[11px] text-ink-950/80 leading-relaxed">
              {t('teamExtra.emailIntro')}
            </p>
            {emailIdentities.length > 0 ? (
              <p className="text-xs font-semibold text-ink-800">
                {t('teamExtra.emailAddresses', { n: emailIdentities.length })}
                {emailStatus?.configuredAt
                  ? ` · saved ${new Date(emailStatus.configuredAt).toLocaleDateString()}`
                  : ''}
              </p>
            ) : (
              <p className="text-xs font-semibold text-amber-800">{t('teamExtra.notConfigured')}</p>
            )}
            {emailStatus && emailStatus.platformReady === false && (
              <p className="text-[11px] text-amber-800 leading-relaxed">
                {t('teamExtra.platformEmailNotReady')}
              </p>
            )}
            <div className="space-y-2">
              {emailIdentities.map((row) => (
                <div
                  key={row.id}
                  className="rounded-lg border border-ink-100 bg-white px-2.5 py-2 space-y-1.5"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                    <input
                      type="text"
                      value={row.label}
                      onChange={(e) =>
                        setEmailIdentities((prev) =>
                          prev.map((item) =>
                            item.id === row.id ? { ...item, label: e.target.value } : item
                          )
                        )
                      }
                      placeholder={t('teamExtra.emailLabelPlaceholder')}
                      className="w-full px-2 py-1.5 rounded-lg border border-ink-200 text-xs font-semibold text-slate-800"
                    />
                    <input
                      type="text"
                      value={row.fromName}
                      onChange={(e) =>
                        setEmailIdentities((prev) =>
                          prev.map((item) =>
                            item.id === row.id ? { ...item, fromName: e.target.value } : item
                          )
                        )
                      }
                      placeholder={tenant.name}
                      className="w-full px-2 py-1.5 rounded-lg border border-ink-200 text-xs font-semibold text-slate-800"
                    />
                    <input
                      type="email"
                      value={row.fromEmail}
                      onChange={(e) =>
                        setEmailIdentities((prev) =>
                          prev.map((item) =>
                            item.id === row.id ? { ...item, fromEmail: e.target.value } : item
                          )
                        )
                      }
                      placeholder="billing@yournursery.com"
                      className="w-full px-2 py-1.5 rounded-lg border border-ink-200 text-xs font-semibold text-slate-800"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {emailDefaultId === row.id ? (
                      <span className="text-[10px] font-bold uppercase tracking-wide bg-ink-100 text-ink-800 px-2 py-0.5 rounded-full">
                        {t('teamExtra.defaultReplyTo')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setEmailDefaultId(row.id)}
                        className="text-[10px] font-bold uppercase tracking-wide text-ink-700 hover:underline"
                      >
                        {t('teamExtra.setDefaultReplyTo')}
                      </button>
                    )}
                    {emailIdentities.length > 1 && (
                      <button
                        type="button"
                        onClick={() => {
                          const next = emailIdentities.filter((item) => item.id !== row.id);
                          setEmailIdentities(next);
                          if (emailDefaultId === row.id) setEmailDefaultId(next[0]?.id || '');
                        }}
                        className="text-[10px] font-bold uppercase tracking-wide text-rose-700 hover:underline ml-auto"
                      >
                        {t('teamExtra.removeReplyTo')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                value={newEmailLabel}
                onChange={(e) => setNewEmailLabel(e.target.value)}
                placeholder={t('teamExtra.emailLabelPlaceholder')}
                className="w-full px-2.5 py-1.5 rounded-lg border border-ink-200 bg-white text-xs font-semibold text-slate-800"
              />
              <input
                type="text"
                value={newEmailFromName}
                onChange={(e) => setNewEmailFromName(e.target.value)}
                placeholder={t('teamExtra.fromName')}
                className="w-full px-2.5 py-1.5 rounded-lg border border-ink-200 bg-white text-xs font-semibold text-slate-800"
              />
              <input
                type="email"
                value={newEmailAddress}
                onChange={(e) => setNewEmailAddress(e.target.value)}
                placeholder="billing@yournursery.com"
                className="w-full px-2.5 py-1.5 rounded-lg border border-ink-200 bg-white text-xs font-semibold text-slate-800"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={emailBusy || busy || !newEmailAddress.trim()}
                onClick={handleAddEmailIdentity}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-ink-200 bg-white text-ink-800 text-xs font-bold disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('teamExtra.addReplyTo')}
              </button>
              <button
                type="button"
                disabled={emailBusy || busy || (emailIdentities.length === 0 && !newEmailAddress.trim())}
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
