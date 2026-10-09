import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Trash2, Undo2, X } from 'lucide-react';
import { InventoryPlant, PLANT_TYPES, PlantType } from '../types';
import {
  deleteInventoryPlants,
  InventoryBulkPatch,
  restoreInventoryPlants,
  updateInventoryPlantsBulk
} from '../lib/inventory';
import { useT } from '../lib/i18n';
import { DEFAULT_CONTAINER_WEIGHTS } from '../data/defaultWeights';
import { isSizeDerivedCategory } from '../lib/availabilityGrouping';

type EditableField =
  | 'plantName'
  | 'containerSize'
  | 'category'
  | 'location'
  | 'listPrice'
  | 'quantityAvailable';

const NO_CATEGORY = '__none__';
const PAGE_SIZE = 300;

interface InventoryManagerModalProps {
  plants: InventoryPlant[];
  onClose: () => void;
}

function fieldText(plant: InventoryPlant, field: EditableField): string {
  const value = plant[field];
  if (value == null) return '';
  if (field === 'listPrice') return Number(value).toFixed(2);
  return String(value);
}

function NameInput({ plant, onSave }: { plant: InventoryPlant; onSave: (name: string) => void }) {
  const [value, setValue] = useState(plant.plantName);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setValue(plant.plantName);
  }, [plant.plantName]);

  function commit() {
    const next = value.trim();
    if (!next) return setValue(plant.plantName);
    if (next !== plant.plantName) onSave(next);
  }

  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          e.preventDefault();
          setValue(plant.plantName);
          focused.current = false;
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="w-full px-1.5 py-1 rounded border border-transparent hover:border-gray-200 focus:border-ink-400 focus:bg-white bg-transparent text-sm font-semibold text-gray-900"
    />
  );
}

/** Blank clears the price (null); invalid input returns undefined. */
function parsePrice(raw: string): number | null | undefined {
  const s = raw.trim().replace(/[$,]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100) / 100;
}

function PriceInput({ plant, onSave }: { plant: InventoryPlant; onSave: (price: number | null) => void }) {
  const display = plant.listPrice == null ? '' : Number(plant.listPrice).toFixed(2);
  const [value, setValue] = useState(display);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setValue(display);
  }, [display]);

  function commit() {
    const next = parsePrice(value);
    if (next === undefined) return setValue(display);
    if ((next ?? null) !== (plant.listPrice ?? null)) onSave(next);
    setValue(next == null ? '' : next.toFixed(2));
  }

  return (
    <div className="relative">
      <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        inputMode="decimal"
        placeholder="—"
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            e.preventDefault();
            setValue(display);
            focused.current = false;
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-full pl-4 pr-1.5 py-1 rounded border border-gray-200 hover:border-gray-300 focus:border-ink-400 bg-white text-sm font-mono text-right"
      />
    </div>
  );
}

const SIZE_OPTIONS = DEFAULT_CONTAINER_WEIGHTS.map((w) => w.label);
const CUSTOM_SIZE = '__custom__';

/** Size-based section label used by the catalog import (#3 → "3 gal", Tray → "Flats"). */
function sectionForSize(size: string): string | null {
  const gallons = size.match(/^#(\d+(?:\.\d+)?)$/);
  if (gallons) return `${gallons[1]} gal`;
  if (size === 'B&B') return 'B&B';
  if (size === 'Tray') return 'Flats';
  return null;
}

/** Full-screen table to delete and edit many inventory plants without opening each one. */
export function InventoryManagerModal({ plants, onClose }: InventoryManagerModalProps) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; field: EditableField } | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());
  const [lastDeleted, setLastDeleted] = useState<InventoryPlant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [bulkCategory, setBulkCategory] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [bulkType, setBulkType] = useState('');
  const [sizeFilter, setSizeFilter] = useState('');
  const [bulkSize, setBulkSize] = useState('');
  const [bulkPrice, setBulkPrice] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, onClose]);

  useEffect(() => setVisibleCount(PAGE_SIZE), [search, categoryFilter, typeFilter, sizeFilter]);

  const sizesInUse = useMemo(
    () =>
      [...new Set<string>(plants.map((p) => (p.containerSize || '').trim()).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b, undefined, { numeric: true })
      ),
    [plants]
  );

  const categories = useMemo(
    () =>
      [...new Set<string>(plants.map((p) => (p.category || '').trim()).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b)
      ),
    [plants]
  );

  const rows = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return plants
      .filter((p) => !pendingDeleteIds.has(p.id))
      .filter((p) => {
        const cat = (p.category || '').trim();
        if (categoryFilter === NO_CATEGORY && cat) return false;
        if (categoryFilter && categoryFilter !== NO_CATEGORY && cat !== categoryFilter) return false;
        if (typeFilter === NO_CATEGORY && p.plantType) return false;
        if (typeFilter && typeFilter !== NO_CATEGORY && p.plantType !== typeFilter) return false;
        if (sizeFilter && (p.containerSize || '').trim() !== sizeFilter) return false;
        if (words.length === 0) return true;
        const hay =
          `${p.plantName} ${p.containerSize} ${cat} ${p.plantType || ''} ${p.location || ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort(
        (a, b) =>
          a.plantName.localeCompare(b.plantName) || a.containerSize.localeCompare(b.containerSize)
      );
  }, [plants, search, categoryFilter, typeFilter, sizeFilter, pendingDeleteIds]);

  const checkedVisible = rows.filter((p) => checked.has(p.id));
  const allChecked = rows.length > 0 && checkedVisible.length === rows.length;

  async function removePlants(ids: string[]) {
    if (ids.length === 0) return;
    const removed = plants.filter((p) => ids.includes(p.id));
    setError(null);
    setPendingDeleteIds((prev) => new Set([...prev, ...ids]));
    setChecked((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    try {
      await deleteInventoryPlants(ids);
      setLastDeleted(removed);
    } catch (err: any) {
      setPendingDeleteIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      setError(err?.message || t('inventory.updateFailed'));
    }
  }

  async function undoDelete() {
    if (lastDeleted.length === 0) return;
    const restoring = lastDeleted;
    setLastDeleted([]);
    try {
      await restoreInventoryPlants(restoring);
      setPendingDeleteIds((prev) => {
        const next = new Set(prev);
        restoring.forEach((p) => next.delete(p.id));
        return next;
      });
    } catch (err: any) {
      setError(err?.message || t('inventory.updateFailed'));
    }
  }

  function startEdit(plant: InventoryPlant, field: EditableField) {
    setEditing({ id: plant.id, field });
    setDraft(fieldText(plant, field));
  }

  async function commitEdit() {
    if (!editing) return;
    const { id, field } = editing;
    setEditing(null);
    const plant = plants.find((p) => p.id === id);
    if (!plant) return;
    const raw = draft.trim();
    if (raw === fieldText(plant, field)) return;

    let patch: InventoryBulkPatch;
    if (field === 'listPrice') {
      if (raw === '') patch = { listPrice: null };
      else {
        const n = Number(raw.replace(/[$,]/g, ''));
        if (!Number.isFinite(n) || n < 0) return setError(t('inventory.bulkInvalidPrice'));
        patch = { listPrice: Math.round(n * 100) / 100 };
      }
    } else if (field === 'quantityAvailable') {
      const n = Number(raw.replace(/,/g, ''));
      if (!Number.isFinite(n)) return;
      patch = { quantityAvailable: Math.round(n) };
    } else if (field === 'plantName' || field === 'containerSize') {
      if (!raw) return;
      patch = { [field]: raw } as InventoryBulkPatch;
    } else {
      patch = { [field]: raw || null } as InventoryBulkPatch;
    }
    setError(null);
    try {
      await updateInventoryPlantsBulk([id], patch);
    } catch (err: any) {
      setError(err?.message || t('inventory.updateFailed'));
    }
  }

  async function savePatch(ids: string[], patch: InventoryBulkPatch) {
    if (ids.length === 0) return;
    setError(null);
    try {
      await updateInventoryPlantsBulk(ids, patch);
    } catch (err: any) {
      setError(err?.message || t('inventory.updateFailed'));
    }
  }

  function applyBulkCategory() {
    void savePatch(checkedVisible.map((p) => p.id), { category: bulkCategory.trim() || null });
  }

  /** Change size; size-based (or empty) sections follow the new size, custom sections stay. */
  async function applySize(targets: InventoryPlant[], size: string) {
    const next = size.trim();
    if (!next || targets.length === 0) return;
    const followIds: string[] = [];
    const keepIds: string[] = [];
    for (const p of targets) {
      if ((p.containerSize || '').trim() === next) continue;
      const cat = (p.category || '').trim();
      (!cat || isSizeDerivedCategory(cat) ? followIds : keepIds).push(p.id);
    }
    await savePatch(followIds, { containerSize: next, category: sectionForSize(next) });
    await savePatch(keepIds, { containerSize: next });
  }

  function chooseSize(targets: InventoryPlant[], value: string) {
    if (value === CUSTOM_SIZE) {
      const custom = window.prompt(t('inventory.managerCustomSizePrompt'), targets[0]?.containerSize || '');
      if (custom?.trim()) void applySize(targets, custom);
      return;
    }
    void applySize(targets, value);
  }

  function applyBulkPrice() {
    const price = parsePrice(bulkPrice);
    if (price === undefined) return setError(t('inventory.bulkInvalidPrice'));
    void savePatch(checkedVisible.map((p) => p.id), { listPrice: price });
  }

  function applyBulkType() {
    if (!bulkType) return;
    void savePatch(checkedVisible.map((p) => p.id), {
      plantType: bulkType === NO_CATEGORY ? null : (bulkType as PlantType)
    });
  }

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function cell(plant: InventoryPlant, field: EditableField, className = '') {
    const isEditing = editing?.id === plant.id && editing.field === field;
    if (isEditing) {
      return (
        <input
          autoFocus
          value={draft}
          list={field === 'category' ? 'inventory-manager-categories' : undefined}
          inputMode={field === 'listPrice' || field === 'quantityAvailable' ? 'decimal' : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commitEdit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditing(null);
          }}
          className={`w-full px-1.5 py-1 rounded border border-ink-400 text-sm bg-white ${className}`}
        />
      );
    }
    const text = fieldText(plant, field);
    return (
      <button
        type="button"
        onClick={() => startEdit(plant, field)}
        className={`w-full text-left px-1.5 py-1 rounded hover:bg-ink-50 hover:ring-1 hover:ring-ink-200 min-h-[1.75rem] ${className}`}
        title={t('inventory.managerClickToEdit')}
      >
        {text ? (
          field === 'listPrice' ? `$${text}` : text
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch justify-center p-2 sm:p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-6xl flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-gray-900">{t('inventory.managerTitle')}</h2>
            <p className="text-xs text-gray-500">{t('inventory.managerHint')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label={t('common.close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[12rem]">
            <Search className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('inventory.searchPlaceholder')}
              className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 text-sm"
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white"
          >
            <option value="">{t('inventory.allCategories')}</option>
            <option value={NO_CATEGORY}>{t('inventory.noCategory')}</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={sizeFilter}
            onChange={(e) => setSizeFilter(e.target.value)}
            className="px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white"
          >
            <option value="">{t('inventory.managerAllSizes')}</option>
            {sizesInUse.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white"
          >
            <option value="">{t('inventory.managerAllTypes')}</option>
            <option value={NO_CATEGORY}>{t('inventory.managerNoType')}</option>
            {PLANT_TYPES.map((pt) => (
              <option key={pt} value={pt}>
                {pt}
              </option>
            ))}
          </select>
          <span className="text-xs font-bold text-gray-500">
            {t('inventory.managerCount', { n: rows.length })}
          </span>
        </div>

        {checkedVisible.length > 0 && (
          <div className="px-4 py-2 bg-ink-50 border-b border-ink-100 flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-ink-900">
              {t('inventory.bulkSelectedCount', { n: checkedVisible.length })}
            </span>
            <button
              type="button"
              onClick={() => void removePlants(checkedVisible.map((p) => p.id))}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-bold hover:bg-red-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('inventory.bulkDelete', { n: checkedVisible.length })}
            </button>
            <select
              value={bulkSize}
              onChange={(e) => setBulkSize(e.target.value)}
              className="px-2 py-1.5 rounded-lg border border-gray-200 text-xs bg-white"
            >
              <option value="">{t('inventory.managerSetSize')}</option>
              {SIZE_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value={CUSTOM_SIZE}>{t('inventory.managerCustomSize')}</option>
            </select>
            <button
              type="button"
              disabled={!bulkSize}
              onClick={() => chooseSize(checkedVisible, bulkSize)}
              className="px-3 py-1.5 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-40"
            >
              {t('inventory.bulkApply', { n: checkedVisible.length })}
            </button>
            <input
              value={bulkPrice}
              onChange={(e) => setBulkPrice(e.target.value)}
              inputMode="decimal"
              placeholder={t('inventory.managerSetPrice')}
              className="px-2 py-1.5 rounded-lg border border-gray-200 text-xs bg-white w-28"
            />
            <button
              type="button"
              disabled={!bulkPrice.trim()}
              onClick={applyBulkPrice}
              className="px-3 py-1.5 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-40"
            >
              {t('inventory.bulkApply', { n: checkedVisible.length })}
            </button>
            <select
              value={bulkType}
              onChange={(e) => setBulkType(e.target.value)}
              className="px-2 py-1.5 rounded-lg border border-gray-200 text-xs bg-white"
            >
              <option value="">{t('inventory.managerSetType')}</option>
              {PLANT_TYPES.map((pt) => (
                <option key={pt} value={pt}>
                  {pt}
                </option>
              ))}
              <option value={NO_CATEGORY}>{t('inventory.managerNoType')}</option>
            </select>
            <button
              type="button"
              disabled={!bulkType}
              onClick={applyBulkType}
              className="px-3 py-1.5 rounded-lg bg-ink-700 text-white text-xs font-bold disabled:opacity-40"
            >
              {t('inventory.bulkApply', { n: checkedVisible.length })}
            </button>
            <input
              value={bulkCategory}
              onChange={(e) => setBulkCategory(e.target.value)}
              list="inventory-manager-categories"
              placeholder={t('inventory.bulkFieldCategory')}
              className="px-2 py-1.5 rounded-lg border border-gray-200 text-xs bg-white w-40"
            />
            <button
              type="button"
              onClick={applyBulkCategory}
              className="px-3 py-1.5 rounded-lg bg-ink-700 text-white text-xs font-bold"
            >
              {t('inventory.bulkApply', { n: checkedVisible.length })}
            </button>
            <button
              type="button"
              onClick={() => setChecked(new Set())}
              className="text-xs font-bold text-ink-700 hover:underline ml-auto"
            >
              {t('inventory.bulkClear')}
            </button>
          </div>
        )}

        {(lastDeleted.length > 0 || error) && (
          <div className="px-4 py-2 border-b border-gray-100 flex items-center gap-3 text-xs">
            {lastDeleted.length > 0 && (
              <>
                <span className="font-medium text-gray-700">
                  {lastDeleted.length === 1
                    ? t('inventory.managerDeletedOne', { name: lastDeleted[0].plantName })
                    : t('inventory.bulkDeleted', { n: lastDeleted.length })}
                </span>
                <button
                  type="button"
                  onClick={() => void undoDelete()}
                  className="inline-flex items-center gap-1 font-bold text-ink-700 hover:underline"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  {t('inventory.managerUndo')}
                </button>
              </>
            )}
            {error && <span className="font-medium text-red-700">{error}</span>}
          </div>
        )}

        <datalist id="inventory-manager-categories">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>

        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 z-10 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-10 px-3 py-2 text-left">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={() =>
                      setChecked(allChecked ? new Set() : new Set(rows.map((p) => p.id)))
                    }
                    className="h-4 w-4"
                    title={t('inventory.bulkSelectShown', { n: rows.length })}
                  />
                </th>
                <th className="px-2 py-2 text-left">{t('inventory.plantName')}</th>
                <th className="px-2 py-2 text-left w-24">{t('inventory.managerSize')}</th>
                <th className="px-2 py-2 text-left w-36">{t('inventory.managerType')}</th>
                <th className="px-2 py-2 text-left w-40">{t('inventory.managerCategory')}</th>
                <th className="px-2 py-2 text-left w-32">{t('inventory.managerLocation')}</th>
                <th className="px-2 py-2 text-right w-24">{t('inventory.managerPrice')}</th>
                <th className="px-2 py-2 text-right w-20">{t('common.qty')}</th>
                <th className="w-12 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, visibleCount).map((plant) => (
                <tr
                  key={plant.id}
                  className={`border-b border-gray-100 ${checked.has(plant.id) ? 'bg-ink-50/60' : 'hover:bg-gray-50'}`}
                >
                  <td className="px-3 py-1">
                    <input
                      type="checkbox"
                      checked={checked.has(plant.id)}
                      onChange={() => toggle(plant.id)}
                      className="h-4 w-4"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <NameInput
                      plant={plant}
                      onSave={(plantName) => void savePatch([plant.id], { plantName })}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <select
                      value={plant.containerSize || ''}
                      onChange={(e) => chooseSize([plant], e.target.value)}
                      className="w-full px-1 py-1 rounded border border-gray-200 text-xs font-mono bg-white"
                    >
                      {!SIZE_OPTIONS.includes(plant.containerSize) && (
                        <option value={plant.containerSize || ''}>{plant.containerSize || '—'}</option>
                      )}
                      {SIZE_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                      <option value={CUSTOM_SIZE}>{t('inventory.managerCustomSize')}</option>
                    </select>
                  </td>
                  <td className="px-1 py-1">
                    <select
                      value={plant.plantType || ''}
                      onChange={(e) =>
                        void savePatch([plant.id], {
                          plantType: (e.target.value as PlantType) || null
                        })
                      }
                      className={`w-full px-1 py-1 rounded border border-gray-200 text-sm bg-white ${plant.plantType ? 'text-gray-900' : 'text-gray-400'}`}
                    >
                      <option value="">—</option>
                      {PLANT_TYPES.map((pt) => (
                        <option key={pt} value={pt}>
                          {pt}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-1 py-1">{cell(plant, 'category')}</td>
                  <td className="px-1 py-1">{cell(plant, 'location')}</td>
                  <td className="px-1 py-1">
                    <PriceInput
                      plant={plant}
                      onSave={(listPrice) => void savePatch([plant.id], { listPrice })}
                    />
                  </td>
                  <td className="px-1 py-1 font-mono text-right">
                    {cell(plant, 'quantityAvailable', 'text-right')}
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      onClick={() => void removePlants([plant.id])}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"
                      title={t('common.delete')}
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="p-6 text-center text-sm text-gray-500">{t('inventory.noInventory')}</p>
          )}
          {rows.length > visibleCount && (
            <div className="p-3 text-center">
              <button
                type="button"
                onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                className="px-4 py-2 rounded-xl border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-50"
              >
                {t('inventory.managerShowMore', { n: rows.length - visibleCount })}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
