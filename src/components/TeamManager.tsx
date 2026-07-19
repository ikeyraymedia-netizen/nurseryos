import { useEffect, useState } from 'react';
import { Users, Copy, Check, UserPlus, Trash2, KeyRound, Shield } from 'lucide-react';
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
  roleLabel,
  rolesLabel
} from '../lib/permissions';
import { TENANT_MODULE_DEFS, resolveEnabledModules } from '../lib/modules';
import { logAuditEvent } from '../lib/audit';

interface TeamManagerProps {
  tenant: Tenant;
  currentUserId: string;
  onClose: () => void;
  onMemberUpdated?: (member: TenantMember) => void;
}

const ASSIGNABLE = getAssignableRoles();

export function TeamManager({
  tenant,
  currentUserId,
  onClose,
  onMemberUpdated
}: TeamManagerProps) {
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
      setError('Owner roles cannot be changed here.');
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
      setError('Pick at least one role.');
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
      setError(err?.message || 'Failed to update roles.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateInvite() {
    if (inviteRoles.length === 0) {
      setError('Pick at least one role for the invite.');
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
    if (memberHasRole(member, 'owner')) {
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
        memberRole: member.role,
        memberRoles: member.roles
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
        meta: {
          memberUserId: member.userId,
          memberEmail: member.email,
          roles: rolesLabel(getMemberRoles(member))
        }
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
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3">
            <p className="text-xs font-bold uppercase text-gray-500 mb-1">Workspace package</p>
            <p className="text-[11px] text-gray-600 mb-2">
              Core always includes orders, trucks, customers, team, and weights.
              {tenant.modules == null
                ? ' This nursery is on a legacy plan (all add-ons).'
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
                        ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
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

          <div>
            <p className="text-xs font-bold uppercase text-gray-500 mb-2">Current members</p>
            <p className="text-[11px] text-gray-500 mb-2 leading-relaxed">
              People can hold more than one role (for example Field + Loader). Use Edit roles to
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
                              className="text-[10px] font-bold uppercase tracking-wide bg-emerald-50 text-emerald-800 px-2 py-1 rounded-full"
                            >
                              {roleLabel(role)}
                            </span>
                          ))}
                      </div>
                    </div>

                    {isEditing ? (
                      <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 p-2.5 space-y-2">
                        <p className="text-[10px] font-bold uppercase text-emerald-800">
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
                                    ? 'bg-emerald-700 text-white border-emerald-800'
                                    : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-300'
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
                            className="flex-1 px-2.5 py-1.5 rounded-lg bg-emerald-700 text-white text-[11px] font-bold disabled:opacity-50"
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
                            className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-bold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                            title="Edit roles"
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
                          title="Send password reset email"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          {resettingUserId === m.userId ? 'Sending…' : 'Reset'}
                        </button>
                        {m.userId !== currentUserId && !isOwner && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleRemoveMember(m)}
                            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[10px] font-bold text-red-700 hover:bg-red-100 disabled:opacity-50"
                            title="Remove member"
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

          <div className="rounded-xl border border-emerald-100 bg-emerald-50/40 p-4">
            <p className="text-xs font-bold uppercase text-emerald-800 mb-2">Invite a team member</p>
            <p className="text-xs text-emerald-900/80 mb-3">
              Select one or more roles for the invite. Supervisor can run trucks and edit order
              lines (BOL, loading) without pricing, invoices, customers, or uploads. Example:
              Field + Loader for inventory plus truck checkoff.
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
                        ? 'bg-emerald-700 text-white border-emerald-800'
                        : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-300'
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
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-700 text-white text-xs font-bold disabled:opacity-50"
            >
              <UserPlus className="h-4 w-4" />
              Create invite ({rolesLabel(inviteRoles)})
            </button>
            {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
            {message && <p className="text-xs text-emerald-800 font-semibold mt-2">{message}</p>}
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
