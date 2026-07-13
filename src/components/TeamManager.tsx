import { useEffect, useState } from 'react';
import { Users, Copy, Check, UserPlus, Trash2, KeyRound } from 'lucide-react';
import { MemberRole, Tenant, TenantInvite, TenantMember } from '../types';
import {
  createTeamInvite,
  listActiveInvites,
  listTeamMembers,
  removeTeamMember,
  sendMemberPasswordReset
} from '../lib/tenants';
import { roleLabel } from '../lib/permissions';
import { logAuditEvent } from '../lib/audit';

interface TeamManagerProps {
  tenant: Tenant;
  currentUserId: string;
  onClose: () => void;
}

export function TeamManager({ tenant, currentUserId, onClose }: TeamManagerProps) {
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [invites, setInvites] = useState<TenantInvite[]>([]);
  const [role, setRole] = useState<Exclude<MemberRole, 'owner'>>('loader');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);

  async function refresh() {
    const [m, i] = await Promise.all([
      listTeamMembers(tenant.id),
      listActiveInvites(tenant.id)
    ]);
    setMembers(m);
    setInvites(i);
  }

  useEffect(() => {
    refresh().catch((err) => setError(err?.message || 'Failed to load team.'));
  }, [tenant.id]);

  async function handleCreateInvite() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const invite = await createTeamInvite({
        tenantId: tenant.id,
        tenantName: tenant.name,
        role,
        createdBy: currentUserId
      });
      await refresh();
      await navigator.clipboard.writeText(invite.code);
      setCopiedCode(invite.code);
      setTimeout(() => setCopiedCode(null), 2000);
    } catch (err: any) {
      setError(err?.message || 'Failed to create invite.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveMember(member: TenantMember) {
    if (member.userId === currentUserId) {
      setError('You cannot remove your own account from this screen.');
      return;
    }
    if (member.role === 'owner') {
      setError('Owner cannot be removed.');
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
        memberRole: member.role
      });
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'Failed to remove member.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword(member: TenantMember) {
    if (!member.email) {
      setError('This team member has no email on file.');
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
        meta: { memberUserId: member.userId, memberEmail: member.email, role: member.role }
      });
      setMessage(`Reset email sent to ${member.email}. Ask them to check inbox/spam.`);
    } catch (err: any) {
      setError(err?.message || 'Failed to send password reset.');
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
            <Users className="h-5 w-5 text-emerald-700" />
            <h3 className="font-bold text-gray-900">Team & Roles</h3>
          </div>
          <button type="button" onClick={onClose} className="text-xs font-bold text-gray-500">
            Close
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <div>
            <p className="text-xs font-bold uppercase text-gray-500 mb-2">Current members</p>
            <p className="text-[11px] text-gray-500 mb-2 leading-relaxed">
              Password resets are owner/admin only: send a reset email from here. Staff cannot reset
              passwords from the login screen.
            </p>
            <div className="space-y-2">
              {members.map((m) => (
                <div
                  key={m.userId}
                  className="flex items-center justify-between gap-2 rounded-xl border border-gray-100 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-gray-900 truncate">
                      {m.displayName || m.email}
                    </p>
                    <p className="text-xs text-gray-500 truncate">{m.email}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[10px] font-bold uppercase tracking-wide bg-emerald-50 text-emerald-800 px-2 py-1 rounded-full">
                      {roleLabel(m.role)}
                    </span>
                    <button
                      type="button"
                      disabled={busy || !m.email}
                      onClick={() => void handleResetPassword(m)}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      title="Send password reset email"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      {resettingUserId === m.userId ? 'Sending…' : 'Reset'}
                    </button>
                    {m.userId !== currentUserId && m.role !== 'owner' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleRemoveMember(m)}
                        className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-bold text-red-700 hover:bg-red-100 disabled:opacity-50"
                        title="Remove member"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-4">
            <p className="text-xs font-bold uppercase text-emerald-800 mb-2">Invite a team member</p>
            <p className="text-xs text-emerald-900/80 mb-3">
              <strong>Loader</strong> can view trucks/orders and check items off only.
              <br />
              <strong>Field</strong> can manage live inventory (qty, sprays, cut-backs).
            </p>
            <div className="flex gap-2 mb-3">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Exclude<MemberRole, 'owner'>)}
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
              >
                <option value="loader">Loader</option>
                <option value="field">Field</option>
                <option value="admin">Admin</option>
              </select>
              <button
                type="button"
                disabled={busy}
                onClick={handleCreateInvite}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700 text-white text-xs font-bold"
              >
                <UserPlus className="h-4 w-4" />
                Create invite
              </button>
            </div>
            {error && <p className="text-xs text-red-600">{error}</p>}
            {message && <p className="text-xs text-emerald-800 font-semibold">{message}</p>}
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
                      <p className="text-xs text-gray-500">{roleLabel(inv.role)} invite</p>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(inv.code);
                        setCopiedCode(inv.code);
                        setTimeout(() => setCopiedCode(null), 2000);
                      }}
                      className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700"
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
