import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Plus,
  Trash2,
  Square
} from 'lucide-react';
import { NurseryTask, Tenant, TenantMember } from '../types';
import { AppPermissions } from '../lib/permissions';
import { listTeamMembers } from '../lib/tenants';
import { getMemberRoles } from '../lib/permissions';
import { useLocale, useRoleLabel, useT } from '../lib/i18n';
import {
  createTask,
  deleteTask,
  formatWeekdayLabel,
  setTaskCompleted,
  startOfWeekMonday,
  subscribeToTasksInRange,
  toDateKey,
  weekDateKeys,
  addDaysToDateKey
} from '../lib/tasks';
import { notifyPushEvent } from '../lib/pushNotifications';
import { logAuditEvent } from '../lib/audit';

interface TasksWorkspaceProps {
  tenant: Tenant;
  member: TenantMember;
  userId: string;
  permissions: AppPermissions;
}

export function TasksWorkspace({ tenant, member, userId, permissions }: TasksWorkspaceProps) {
  const t = useT();
  const { locale } = useLocale();
  const { rolesLabel } = useRoleLabel();
  const [weekStart, setWeekStart] = useState(() => startOfWeekMonday());
  const [tasks, setTasks] = useState<NurseryTask[]>([]);
  const [team, setTeam] = useState<TenantMember[]>([]);
  const [filterMine, setFilterMine] = useState(!permissions.canAssignTasks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueDate, setDueDate] = useState(() => toDateKey(new Date()));
  const [assigneeUserId, setAssigneeUserId] = useState(userId);

  const days = useMemo(() => weekDateKeys(weekStart), [weekStart]);
  const weekEnd = days[6];
  const todayKey = toDateKey(new Date());

  useEffect(() => {
    listTeamMembers(tenant.id)
      .then(setTeam)
      .catch(() => setTeam([]));
  }, [tenant.id]);

  useEffect(() => {
    return subscribeToTasksInRange(weekStart, weekEnd, setTasks);
  }, [weekStart, weekEnd]);

  const visibleTasks = useMemo(() => {
    if (!filterMine) return tasks;
    return tasks.filter((t) => t.assigneeUserId === userId);
  }, [tasks, filterMine, userId]);

  const tasksByDay = useMemo(() => {
    const map: Record<string, NurseryTask[]> = {};
    for (const day of days) map[day] = [];
    for (const task of visibleTasks) {
      if (!map[task.dueDate]) map[task.dueDate] = [];
      map[task.dueDate].push(task);
    }
    for (const day of days) {
      map[day].sort((a, b) => {
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return a.title.localeCompare(b.title);
      });
    }
    return map;
  }, [visibleTasks, days]);

  const openCount = visibleTasks.filter((t) => !t.completed).length;
  const doneCount = visibleTasks.filter((t) => t.completed).length;

  function memberLabel(m: TenantMember) {
    return m.displayName || m.email || m.userId;
  }

  function resetForm() {
    setTitle('');
    setNotes('');
    setDueDate(todayKey);
    setAssigneeUserId(userId);
    setShowForm(false);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!permissions.canAssignTasks) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setError(t('tasks.enterTitle'));
      return;
    }
    const assignee = team.find((m) => m.userId === assigneeUserId);
    if (!assignee) {
      setError(t('tasks.pickAssignee'));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await createTask({
        title: trimmed,
        notes,
        dueDate,
        assigneeUserId: assignee.userId,
        assigneeName: memberLabel(assignee),
        assigneeEmail: assignee.email,
        createdByUserId: userId,
        createdByName: member.displayName || member.email || 'Owner'
      });
      void notifyPushEvent({
        tenantId: tenant.id,
        type: 'task_assigned',
        title: `New task · ${trimmed}`,
        body: `Due ${dueDate}`,
        url: '/?tab=tasks',
        targetUserId: assignee.userId
      });
      await logAuditEvent({
        action: 'task.created',
        summary: `Assigned “${trimmed}” to ${memberLabel(assignee)} for ${dueDate}`,
        meta: { assigneeUserId: assignee.userId, dueDate }
      });
      resetForm();
    } catch (err: any) {
      setError(err?.message || t('tasks.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(task: NurseryTask) {
    const canComplete =
      permissions.canAssignTasks ||
      (permissions.canCompleteTasks && task.assigneeUserId === userId);
    if (!canComplete) return;

    setBusy(true);
    setError(null);
    try {
      await setTaskCompleted({
        taskId: task.id,
        completed: !task.completed,
        userId
      });
    } catch (err: any) {
      setError(err?.message || t('tasks.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(task: NurseryTask) {
    if (!permissions.canAssignTasks) return;
    const ok = window.confirm(t('tasks.deleteConfirm', { title: task.title }));
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await deleteTask(task.id);
    } catch (err: any) {
      setError(err?.message || t('tasks.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (!permissions.canViewTasks) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-gray-500">
        {t('tasks.notAvailable')}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-h-[520px]">
      <div className="bg-slate-900 text-white px-5 py-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-ink-500/20 flex items-center justify-center shrink-0">
            <ClipboardList className="h-5 w-5 text-ink-300" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-black tracking-tight">{t('tasks.title')}</h2>
            <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">{t('tasks.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setWeekStart(addDaysToDateKey(weekStart, -7))}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/15"
            title={t('tasks.previousWeek')}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setWeekStart(startOfWeekMonday())}
            className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-[11px] font-bold"
          >
            {t('tasks.thisWeek')}
          </button>
          <button
            type="button"
            onClick={() => setWeekStart(addDaysToDateKey(weekStart, 7))}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/15"
            title={t('tasks.nextWeek')}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="p-4 sm:p-5 space-y-4 flex-1 flex flex-col">
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold text-ink-900 bg-ink-50 border border-ink-100 rounded-lg px-2.5 py-1">
              {t('tasks.openDone', { open: openCount, done: doneCount })}
            </span>
            <button
              type="button"
              onClick={() => setFilterMine((v) => !v)}
              className={`text-[11px] font-bold rounded-lg px-2.5 py-1 border transition-colors ${
                filterMine
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {filterMine ? t('tasks.showingMine') : t('tasks.showingAll')}
            </button>
          </div>
          {permissions.canAssignTasks && (
            <button
              type="button"
              onClick={() => setShowForm((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink-700 hover:bg-ink-800 text-white text-xs font-bold"
            >
              <Plus className="h-4 w-4" />
              {showForm ? t('common.close') : t('tasks.newTask')}
            </button>
          )}
        </div>

        {error && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        {permissions.canAssignTasks && showForm && (
          <form
            onSubmit={handleCreate}
            className="border border-ink-100 bg-ink-50/40 rounded-2xl p-4 space-y-3"
          >
            <p className="text-xs font-bold uppercase tracking-wide text-ink-900">{t('tasks.createTask')}</p>
            <div className="grid sm:grid-cols-2 gap-3">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('tasks.taskTitle')}
                className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                disabled={busy}
              />
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                disabled={busy}
              />
              <select
                value={assigneeUserId}
                onChange={(e) => setAssigneeUserId(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white"
                disabled={busy}
              >
                {(team.some((m) => m.userId === userId) ? team : [member, ...team]).map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {memberLabel(m)}
                    {m.userId === userId ? ` ${t('tasks.me')}` : ''} — {rolesLabel(getMemberRoles(m))}
                  </option>
                ))}
              </select>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('tasks.notesOptional')}
                rows={2}
                className="sm:col-span-2 px-3 py-2 border border-gray-200 rounded-xl text-sm bg-white resize-none"
                disabled={busy}
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-ink-700 text-white text-xs font-bold disabled:opacity-50"
            >
              {t('tasks.assignTask')}
            </button>
          </form>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 flex-1">
          {days.map((day) => {
            const dayTasks = tasksByDay[day] || [];
            const isToday = day === todayKey;
            return (
              <div
                key={day}
                className={`rounded-2xl border p-3 flex flex-col min-h-[160px] ${
                  isToday
                    ? 'border-ink-300 bg-ink-50/40'
                    : 'border-slate-200 bg-slate-50/50'
                }`}
              >
                <div className="flex items-baseline justify-between mb-2">
                  <p
                    className={`text-xs font-black uppercase tracking-wide ${
                      isToday ? 'text-ink-900' : 'text-slate-600'
                    }`}
                  >
                    {formatWeekdayLabel(day, locale)}
                  </p>
                  <span className="text-[10px] font-bold text-slate-400">
                    {t('tasks.left', { n: dayTasks.filter((t) => !t.completed).length })}
                  </span>
                </div>
                <div className="space-y-2 flex-1">
                  {dayTasks.length === 0 ? (
                    <p className="text-[11px] text-slate-400 py-4 text-center">{t('tasks.noTasks')}</p>
                  ) : (
                    dayTasks.map((task) => {
                      const canToggle =
                        permissions.canAssignTasks ||
                        (permissions.canCompleteTasks && task.assigneeUserId === userId);
                      return (
                        <div
                          key={task.id}
                          className={`rounded-xl border bg-white px-2.5 py-2 ${
                            task.completed
                              ? 'border-slate-100 opacity-70'
                              : 'border-slate-200 shadow-sm'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <button
                              type="button"
                              disabled={!canToggle || busy}
                              onClick={() => void handleToggle(task)}
                              className="mt-0.5 shrink-0 text-ink-700 disabled:opacity-30 disabled:cursor-not-allowed touch-manipulation"
                              title={task.completed ? t('tasks.markIncomplete') : t('tasks.markComplete')}
                              aria-label={task.completed ? t('tasks.markIncomplete') : t('tasks.markComplete')}
                            >
                              {task.completed ? (
                                <CheckSquare className="h-5 w-5" />
                              ) : (
                                <Square className="h-5 w-5" />
                              )}
                            </button>
                            <div className="min-w-0 flex-1">
                              <p
                                className={`text-xs font-bold text-gray-900 leading-snug ${
                                  task.completed ? 'line-through text-gray-500' : ''
                                }`}
                              >
                                {task.title}
                              </p>
                              <p className="text-[10px] text-slate-500 mt-0.5 truncate">
                                {task.assigneeName}
                                {task.assigneeUserId === userId ? ` ${t('tasks.you')}` : ''}
                              </p>
                              {task.notes && (
                                <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
                                  {task.notes}
                                </p>
                              )}
                            </div>
                            {permissions.canAssignTasks && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleDelete(task)}
                                className="shrink-0 p-1 rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-40"
                                title={t('tasks.deleteTask')}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                {permissions.canAssignTasks && (
                  <button
                    type="button"
                    onClick={() => {
                      setDueDate(day);
                      setShowForm(true);
                    }}
                    className="mt-2 w-full text-[10px] font-bold text-ink-800 hover:bg-ink-100/60 rounded-lg py-1.5 border border-dashed border-ink-200"
                  >
                    {t('tasks.addForDay')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
