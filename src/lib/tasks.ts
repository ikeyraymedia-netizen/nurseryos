import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where
} from 'firebase/firestore';
import { db } from '../firebase';
import { NurseryTask } from '../types';

let activeTenantId: string | null = null;

export function setTasksTenant(tenantId: string | null) {
  activeTenantId = tenantId;
}

function requireTenantId(): string {
  if (!activeTenantId) throw new Error('No active nursery selected.');
  return activeTenantId;
}

function tasksCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'tasks');
}

function taskDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'tasks', id);
}

function sanitizeForFirestore<T>(data: T): T {
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeForFirestore(item)) as T;
  }
  if (data && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (value === undefined) continue;
      result[key] = sanitizeForFirestore(value);
    }
    return result as T;
  }
  return data;
}

/** Monday (local) as YYYY-MM-DD for the week containing `date`. */
export function startOfWeekMonday(date = new Date()): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toDateKey(d);
}

export function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return toDateKey(dt);
}

export function weekDateKeys(weekStartMonday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysToDateKey(weekStartMonday, i));
}

export function formatWeekdayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  });
}

export function subscribeToTasksInRange(
  startDate: string,
  endDate: string,
  callback: (tasks: NurseryTask[]) => void
): () => void {
  if (!activeTenantId) {
    callback([]);
    return () => undefined;
  }
  const tenantId = activeTenantId;
  const q = query(
    tasksCol(tenantId),
    where('dueDate', '>=', startDate),
    where('dueDate', '<=', endDate),
    orderBy('dueDate', 'asc')
  );

  return onSnapshot(
    q,
    (snap) => {
      const tasks = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<NurseryTask, 'id'>) }));
      callback(tasks);
    },
    (err) => {
      console.error('Tasks subscription failed:', err);
      callback([]);
    }
  );
}

export async function createTask(input: {
  title: string;
  notes?: string;
  dueDate: string;
  assigneeUserId: string;
  assigneeName: string;
  assigneeEmail?: string;
  createdByUserId: string;
  createdByName: string;
}): Promise<string> {
  const tenantId = requireTenantId();
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const task: NurseryTask = {
    id,
    title: input.title.trim(),
    notes: input.notes?.trim() || undefined,
    dueDate: input.dueDate,
    assigneeUserId: input.assigneeUserId,
    assigneeName: input.assigneeName,
    assigneeEmail: input.assigneeEmail || undefined,
    createdByUserId: input.createdByUserId,
    createdByName: input.createdByName,
    completed: false,
    completedAt: null,
    completedByUserId: null,
    createdAt: now,
    updatedAt: now
  };
  await setDoc(taskDoc(tenantId, id), sanitizeForFirestore(task));
  return id;
}

export async function setTaskCompleted(params: {
  taskId: string;
  completed: boolean;
  userId: string;
}): Promise<void> {
  const tenantId = requireTenantId();
  const now = new Date().toISOString();
  await updateDoc(
    taskDoc(tenantId, params.taskId),
    sanitizeForFirestore({
      completed: params.completed,
      completedAt: params.completed ? now : null,
      completedByUserId: params.completed ? params.userId : null,
      updatedAt: now
    })
  );
}

export async function updateTask(params: {
  taskId: string;
  title: string;
  notes?: string;
  dueDate: string;
  assigneeUserId: string;
  assigneeName: string;
  assigneeEmail?: string;
}): Promise<void> {
  const tenantId = requireTenantId();
  await updateDoc(
    taskDoc(tenantId, params.taskId),
    sanitizeForFirestore({
      title: params.title.trim(),
      notes: params.notes?.trim() || null,
      dueDate: params.dueDate,
      assigneeUserId: params.assigneeUserId,
      assigneeName: params.assigneeName,
      assigneeEmail: params.assigneeEmail || null,
      updatedAt: new Date().toISOString()
    })
  );
}

export async function deleteTask(taskId: string): Promise<void> {
  const tenantId = requireTenantId();
  await deleteDoc(taskDoc(tenantId, taskId));
}
