import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch
} from 'firebase/firestore';
import { db } from '../firebase';
import { ChemicalApplication, InventoryPlant } from '../types';
import {
  findMatchingInventoryPlants,
  normalizeContainerSize,
  normalizePlantName,
  plantNamesMatch
} from './inventoryMatch';
import { DEFAULT_CONTAINER_WEIGHTS } from '../data/defaultWeights';
import { ContainerWeight } from '../types';

export interface InventoryAdjustResult {
  updatedCount: number;
  unmatched: Array<{ plantName: string; containerSize: string; delta: number }>;
  shortfalls: Array<{ plantName: string; containerSize: string; amount: number }>;
  inventorySummary?: string;
}

interface InventoryAlias {
  sourceName: string;
  sourceSize: string;
  targetName: string;
  targetSize: string;
}

let activeTenantId: string | null = null;

export function setInventoryTenant(tenantId: string | null) {
  activeTenantId = tenantId;
}

function requireTenantId(): string {
  if (!activeTenantId) {
    throw new Error('No active nursery selected.');
  }
  return activeTenantId;
}

function inventoryCol(tenantId: string) {
  return collection(db, 'tenants', tenantId, 'inventory');
}

function inventoryDoc(tenantId: string, id: string) {
  return doc(db, 'tenants', tenantId, 'inventory', id);
}

function inventoryAliasKey(tenantId: string) {
  return `inventory_name_aliases_${tenantId}`;
}

function loadAliases(tenantId: string): InventoryAlias[] {
  try {
    const raw = localStorage.getItem(inventoryAliasKey(tenantId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAliases(tenantId: string, aliases: InventoryAlias[]) {
  localStorage.setItem(inventoryAliasKey(tenantId), JSON.stringify(aliases));
}

function saveAlias(
  tenantId: string,
  sourceName: string,
  sourceSize: string,
  targetName: string,
  targetSize: string
) {
  const aliases = loadAliases(tenantId);
  const next: InventoryAlias = { sourceName, sourceSize, targetName, targetSize };
  const filtered = aliases.filter(
    (a) => !(a.sourceName === sourceName && a.sourceSize === sourceSize)
  );
  filtered.push(next);
  saveAliases(tenantId, filtered);
}

function getAliasedMatches(
  tenantId: string,
  plants: InventoryPlant[],
  plantName: string,
  containerSize: string
): InventoryPlant[] {
  const sourceName = normalizePlantName(plantName);
  const sourceSize = normalizeContainerSize(containerSize);
  const alias = loadAliases(tenantId).find(
    (a) => a.sourceName === sourceName && a.sourceSize === sourceSize
  );
  if (!alias) return [];
  return plants.filter(
    (p) =>
      normalizePlantName(p.plantName) === alias.targetName &&
      normalizeContainerSize(p.containerSize) === alias.targetSize
  );
}

function similarityScore(a: string, b: string): number {
  const wordsA = new Set(normalizePlantName(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizePlantName(b).split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  wordsA.forEach((w) => {
    if (wordsB.has(w)) overlap += 1;
  });
  return overlap / Math.max(wordsA.size, wordsB.size);
}

export interface InventoryMatchSuggestion {
  plant: InventoryPlant;
  score: number;
}

export interface InventoryMatchRequest {
  tenantId: string;
  plantName: string;
  containerSize: string;
  quantityHint?: number;
  suggestions: InventoryMatchSuggestion[];
}

export type InventoryMatchResolver = (
  request: InventoryMatchRequest
) => Promise<InventoryPlant[] | null>;

let inventoryMatchResolver: InventoryMatchResolver | null = null;

export function setInventoryMatchResolver(resolver: InventoryMatchResolver | null) {
  inventoryMatchResolver = resolver;
}

export function getInventoryMatchSuggestions(
  plants: InventoryPlant[],
  plantName: string,
  containerSize: string,
  weights: ContainerWeight[] = DEFAULT_CONTAINER_WEIGHTS,
  limit = 6
): InventoryMatchSuggestion[] {
  if (plants.length === 0) return [];

  const normalizedSize = normalizeContainerSize(containerSize, weights);

  return plants
    .map((plant) => {
      const sizeMatch =
        normalizeContainerSize(plant.containerSize, weights) === normalizedSize;
      let score = similarityScore(plantName, plant.plantName);
      if (plantNamesMatch(plantName, plant.plantName)) {
        score = Math.max(score, 0.75);
      }
      if (sizeMatch) {
        score += 0.2;
      } else {
        score *= 0.5;
      }
      return { plant, score: Math.min(1, score), sizeMatch };
    })
    .filter(
      (x) =>
        x.score >= 0.12 ||
        plantNamesMatch(plantName, x.plant.plantName) ||
        x.sizeMatch
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ plant, score }) => ({ plant, score }));
}

/** Open match UI (or use exact/alias) to link an order line to inventory. */
export async function promptInventoryLink(
  tenantId: string,
  plants: InventoryPlant[],
  plantName: string,
  containerSize: string,
  quantityHint?: number,
  weights: ContainerWeight[] = DEFAULT_CONTAINER_WEIGHTS
): Promise<InventoryPlant[] | null> {
  const exact = findMatchingInventoryPlants(plants, plantName, containerSize, weights);
  if (exact.length > 0) return exact;

  const aliased = getAliasedMatches(tenantId, plants, plantName, containerSize);
  if (aliased.length > 0) return aliased;

  if (!inventoryMatchResolver) return null;

  const suggestions = getInventoryMatchSuggestions(
    plants,
    plantName,
    containerSize,
    weights
  );
  const resolved = await inventoryMatchResolver({
    tenantId,
    plantName,
    containerSize,
    quantityHint,
    suggestions
  });
  if (!resolved || resolved.length === 0) return null;

  const chosen = resolved[0];
  const matches = plantsMatchingAliasTarget(plants, chosen.plantName, chosen.containerSize);
  return matches.length > 0 ? matches : resolved;
}

export function rememberInventoryAlias(
  tenantId: string,
  sourceName: string,
  sourceSize: string,
  targetName: string,
  targetSize: string
) {
  saveAlias(
    tenantId,
    normalizePlantName(sourceName),
    normalizeContainerSize(sourceSize),
    normalizePlantName(targetName),
    normalizeContainerSize(targetSize)
  );
}

export function plantsMatchingAliasTarget(
  plants: InventoryPlant[],
  targetName: string,
  targetSize: string
): InventoryPlant[] {
  return plants.filter(
    (p) =>
      normalizePlantName(p.plantName) === normalizePlantName(targetName) &&
      normalizeContainerSize(p.containerSize) === normalizeContainerSize(targetSize)
  );
}

async function resolveInventoryAlias(
  tenantId: string,
  plants: InventoryPlant[],
  plantName: string,
  containerSize: string,
  quantityHint?: number
): Promise<InventoryPlant[]> {
  const linked = await promptInventoryLink(
    tenantId,
    plants,
    plantName,
    containerSize,
    quantityHint
  );
  return linked ?? [];
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

export function subscribeToInventory(callback: (plants: InventoryPlant[]) => void) {
  if (!activeTenantId) {
    callback([]);
    return () => {};
  }

  const tenantId = activeTenantId;
  const q = query(inventoryCol(tenantId), orderBy('plantName', 'asc'));
  return onSnapshot(
    q,
    (snapshot) => {
      const plants: InventoryPlant[] = [];
      snapshot.forEach((docSnap) => {
        plants.push({ id: docSnap.id, ...(docSnap.data() as Omit<InventoryPlant, 'id'>) });
      });
      callback(plants);
    },
    (error) => {
      console.error('Error subscribing to inventory:', error);
      callback([]);
    }
  );
}

export async function addInventoryPlant(
  plant: Omit<InventoryPlant, 'id' | 'dateCreated' | 'dateUpdated'>
): Promise<string> {
  const tenantId = requireTenantId();
  const id = `inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const fullPlant: InventoryPlant = {
    ...plant,
    id,
    chemicals: plant.chemicals || [],
    dateCreated: now,
    dateUpdated: now
  };
  await setDoc(inventoryDoc(tenantId, id), sanitizeForFirestore(fullPlant));
  return id;
}

export async function updateInventoryPlant(plant: InventoryPlant): Promise<void> {
  const tenantId = requireTenantId();
  const { id, ...rest } = plant;
  await updateDoc(
    inventoryDoc(tenantId, id),
    sanitizeForFirestore({
      ...rest,
      dateUpdated: new Date().toISOString()
    })
  );
}

export async function deleteInventoryPlant(plantId: string): Promise<void> {
  const tenantId = requireTenantId();
  await deleteDoc(inventoryDoc(tenantId, plantId));
}

export async function deleteAllInventoryPlants(): Promise<number> {
  const tenantId = requireTenantId();
  const snapshot = await getDocs(inventoryCol(tenantId));
  if (snapshot.empty) return 0;

  let deleted = 0;
  let batch = writeBatch(db);
  let ops = 0;

  for (const docSnap of snapshot.docs) {
    batch.delete(docSnap.ref);
    ops += 1;
    deleted += 1;
    if (ops >= 500) {
      await batch.commit();
      batch = writeBatch(db);
      ops = 0;
    }
  }

  if (ops > 0) await batch.commit();
  return deleted;
}

export async function addChemicalApplication(
  plantId: string,
  chemical: ChemicalApplication,
  currentPlant: InventoryPlant
): Promise<void> {
  const updated: InventoryPlant = {
    ...currentPlant,
    chemicals: [...(currentPlant.chemicals || []), chemical]
  };
  await updateInventoryPlant(updated);
}

export function parseCsvInventory(text: string): Array<Omit<InventoryPlant, 'id' | 'dateCreated' | 'dateUpdated'>> {
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return [];

  const rawLines = cleaned.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rawLines.length < 2) return [];

  const delimiter = detectCsvDelimiter(rawLines[0]);
  const table = rawLines.map((line) => splitCsvLine(line, delimiter));
  return mapTableToInventory(table);
}

function detectCsvDelimiter(headerLine: string): string {
  const comma = (headerLine.match(/,/g) || []).length;
  const semi = (headerLine.match(/;/g) || []).length;
  const tab = (headerLine.match(/\t/g) || []).length;
  if (tab >= comma && tab >= semi && tab > 0) return '\t';
  if (semi > comma) return ';';
  return ',';
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normalizeHeaderCell(value: string): string {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function pickColumn(headers: string[], aliasGroups: string[][]): number {
  for (const aliases of aliasGroups) {
    for (const alias of aliases) {
      const exact = headers.findIndex((h) => h === alias);
      if (exact >= 0) return exact;
    }
    for (const alias of aliases) {
      const partial = headers.findIndex((h) => h.includes(alias));
      if (partial >= 0) return partial;
    }
  }
  return -1;
}

function parseQty(raw: string): number {
  const cleaned = String(raw || '').replace(/,/g, '').replace(/[^\d.-]/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function mapTableToInventory(
  table: string[][]
): Array<Omit<InventoryPlant, 'id' | 'dateCreated' | 'dateUpdated'>> {
  if (table.length < 2) return [];

  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(table.length, 25); i += 1) {
    const headers = table[i].map(normalizeHeaderCell);
    const nameIdx = pickColumn(headers, [
      ['plant name', 'plant', 'botanical name', 'botanical', 'species', 'variety', 'cultivar'],
      ['description', 'item description', 'product name', 'product', 'item'],
      ['name']
    ]);
    if (nameIdx >= 0) {
      headerRowIdx = i;
      break;
    }
  }

  const headers = table[headerRowIdx].map(normalizeHeaderCell);
  const nameIdx = pickColumn(headers, [
    ['plant name', 'plant', 'botanical name', 'botanical', 'species', 'variety', 'cultivar'],
    ['description', 'item description', 'product name', 'product', 'item'],
    ['name']
  ]);
  if (nameIdx < 0) return [];

  const sizeIdx = pickColumn(headers, [
    ['container size', 'container', 'pot size', 'size', 'gallon', 'caliper', 'pot']
  ]);
  const qtyIdx = pickColumn(headers, [
    ['qty available', 'quantity available', 'on hand', 'available', 'qty', 'quantity', 'stock', 'count', 'inventory']
  ]);
  const weeksIdx = pickColumn(headers, [['weeks until ready', 'weeks', 'week', 'ready']]);
  const locationIdx = pickColumn(headers, [
    ['location', 'bed', 'block', 'bay', 'zone', 'aisle', 'house', 'yard']
  ]);
  const notesIdx = pickColumn(headers, [['notes', 'note', 'comment', 'remarks', 'memo']]);

  const out: Array<Omit<InventoryPlant, 'id' | 'dateCreated' | 'dateUpdated'>> = [];
  for (const row of table.slice(headerRowIdx + 1)) {
    const plantName = String(row[nameIdx] || '').trim();
    if (!plantName) continue;
    if (normalizeHeaderCell(plantName) === headers[nameIdx]) continue;

    const entry: Omit<InventoryPlant, 'id' | 'dateCreated' | 'dateUpdated'> = {
      plantName,
      containerSize: sizeIdx >= 0 ? String(row[sizeIdx] || '').trim() || 'Other' : 'Other',
      quantityAvailable: qtyIdx >= 0 ? parseQty(row[qtyIdx]) : 0,
      weeksUntilReady:
        weeksIdx >= 0 && String(row[weeksIdx] || '').trim()
          ? Number(String(row[weeksIdx]).replace(/[^\d.-]/g, '')) || null
          : null,
      chemicals: [],
      cutBackAt: null,
      notes: notesIdx >= 0 ? String(row[notesIdx] || '').trim() : ''
    };
    if (locationIdx >= 0 && String(row[locationIdx] || '').trim()) {
      entry.location = String(row[locationIdx]).trim();
    }
    out.push(entry);
  }
  return out;
}

/** Parse .xlsx / .xls nursery inventory sheets without AI. */
export async function parseExcelInventory(
  file: File
): Promise<Array<Omit<InventoryPlant, 'id' | 'dateCreated' | 'dateUpdated'>>> {
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const workbook = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return [];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<(string | number | null | undefined)[]>(sheet, {
    header: 1,
    defval: '',
    raw: false
  }) as (string | number | null | undefined)[][];

  const table = rows.map((row) => (Array.isArray(row) ? row : []).map((c) => String(c ?? '').trim()));
  return mapTableToInventory(table);
}

export async function bulkImportInventoryPlants(
  plants: Array<Omit<InventoryPlant, 'id' | 'dateCreated' | 'dateUpdated'>>
): Promise<number> {
  if (plants.length === 0) return 0;
  const tenantId = requireTenantId();
  const now = new Date().toISOString();
  let count = 0;
  let batch = writeBatch(db);
  let ops = 0;

  for (const plant of plants) {
    const id = `inv-${Date.now()}-${count}-${Math.random().toString(36).slice(2, 6)}`;
    const fullPlant: InventoryPlant = {
      ...plant,
      id,
      chemicals: plant.chemicals || [],
      dateCreated: now,
      dateUpdated: now
    };
    batch.set(inventoryDoc(tenantId, id), sanitizeForFirestore(fullPlant));
    ops += 1;
    count += 1;
    if (ops >= 400) {
      await batch.commit();
      batch = writeBatch(db);
      ops = 0;
    }
  }

  if (ops > 0) await batch.commit();
  return count;
}

export function inventoryMatchKey(plantName: string, containerSize: string): string {
  return `${plantName.trim().toLowerCase()}::${containerSize.trim().toLowerCase()}`;
}

export interface InventoryLoadDelta {
  plantName: string;
  containerSize: string;
  delta: number;
}

/** Adjust inventory qty when loaders check off plants (positive delta = deduct, negative = restore). */
export async function adjustInventoryForLoadDeltas(
  deltas: InventoryLoadDelta[],
  tenantIdOverride?: string
): Promise<InventoryAdjustResult> {
  const result: InventoryAdjustResult = { updatedCount: 0, unmatched: [], shortfalls: [] };
  const meaningful = deltas.filter((d) => d.delta !== 0);
  if (meaningful.length === 0) return result;

  const tenantId = tenantIdOverride || requireTenantId();
  const snapshot = await getDocs(inventoryCol(tenantId));
  const plants: InventoryPlant[] = [];
  snapshot.forEach((docSnap) => {
    plants.push({ id: docSnap.id, ...(docSnap.data() as Omit<InventoryPlant, 'id'>) });
  });

  if (plants.length === 0) {
    result.inventorySummary = 'No plants in live inventory yet.';
  } else {
    result.inventorySummary = plants
      .slice(0, 8)
      .map((p) => `${p.plantName} (${p.containerSize})`)
      .join(', ');
  }

  const pendingQty = new Map<string, number>();
  const getQty = (plant: InventoryPlant) =>
    pendingQty.has(plant.id) ? pendingQty.get(plant.id)! : plant.quantityAvailable;

  for (const { plantName, containerSize, delta } of meaningful) {
    let matches = findMatchingInventoryPlants(plants, plantName, containerSize);
    if (matches.length === 0) {
      matches = getAliasedMatches(tenantId, plants, plantName, containerSize);
    }
    if (matches.length === 0) {
      matches = await resolveInventoryAlias(tenantId, plants, plantName, containerSize, Math.abs(delta));
    }
    if (matches.length === 0) {
      result.unmatched.push({ plantName, containerSize, delta });
      continue;
    }

    const sorted = [...matches].sort((a, b) => getQty(b) - getQty(a));

    if (delta > 0) {
      let remaining = delta;
      for (const plant of sorted) {
        if (remaining <= 0) break;
        const current = getQty(plant);
        const deduct = Math.min(current, remaining);
        pendingQty.set(plant.id, current - deduct);
        remaining -= deduct;
      }
      if (remaining > 0) {
        result.shortfalls.push({ plantName, containerSize, amount: remaining });
      }
    } else {
      const plant = sorted[0];
      pendingQty.set(plant.id, getQty(plant) + Math.abs(delta));
    }
  }

  if (pendingQty.size === 0) return result;

  const batch = writeBatch(db);
  const now = new Date().toISOString();
  for (const [plantId, qty] of pendingQty) {
    batch.update(inventoryDoc(tenantId, plantId), {
      quantityAvailable: Math.max(0, qty),
      dateUpdated: now
    });
    result.updatedCount += 1;
  }
  await batch.commit();
  return result;
}

export async function adjustInventoryForLoadDelta(
  plantName: string,
  containerSize: string,
  delta: number
): Promise<InventoryAdjustResult> {
  return adjustInventoryForLoadDeltas([{ plantName, containerSize, delta }]);
}

export function describeInventorySyncResult(result: InventoryAdjustResult): string {
  const parts: string[] = [];
  if (result.updatedCount > 0) {
    parts.push(`Updated ${result.updatedCount} inventory row(s).`);
  }
  for (const u of result.unmatched) {
    parts.push(`"${u.plantName}" (${u.containerSize}) — no matching inventory row`);
  }
  for (const s of result.shortfalls) {
    parts.push(`"${s.plantName}" (${s.containerSize}) — not enough stock on hand`);
  }
  if (parts.length === 0) {
    return 'No inventory changes were needed.';
  }
  if (result.unmatched.length > 0 && result.inventorySummary) {
    parts.push(`Inventory on file: ${result.inventorySummary}`);
  }
  return parts.join('\n');
}

export function inventorySyncSucceeded(result: InventoryAdjustResult): boolean {
  return result.unmatched.length === 0 && result.shortfalls.length === 0;
}

export function notifyInventorySyncIssue(note: string) {
  const lower = note.toLowerCase();
  const isIssue =
    lower.includes('no matching inventory row') ||
    lower.includes('not enough stock') ||
    lower.includes('could not be updated');
  if (isIssue) {
    window.alert(note);
  }
}
