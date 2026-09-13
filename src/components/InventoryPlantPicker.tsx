import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Link2, X } from 'lucide-react';
import { ContainerWeight, InventoryPlant } from '../types';

export type InventoryPlantPick = {
  plantName: string;
  containerSize?: string;
  inventoryItemId?: string;
};

interface InventoryPlantPickerProps {
  plants: InventoryPlant[];
  plantName: string;
  containerSize?: string;
  inventoryItemId?: string;
  containerWeights?: ContainerWeight[];
  onChange: (next: InventoryPlantPick) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  /** When true (default), selecting a match also fills container size. */
  applySizeOnSelect?: boolean;
}

function resolveContainerSizeId(size: string, weights: ContainerWeight[]): string {
  const raw = size.trim();
  if (!raw) return '';
  const match = weights.find(
    (w) =>
      w.id.toLowerCase() === raw.toLowerCase() ||
      w.label.toLowerCase() === raw.toLowerCase() ||
      w.name.toLowerCase() === raw.toLowerCase()
  );
  return match?.id || raw;
}

function filterInventoryPlants(plants: InventoryPlant[], query: string): InventoryPlant[] {
  const sorted = [...plants].sort((a, b) =>
    a.plantName.localeCompare(b.plantName, undefined, { sensitivity: 'base' })
  );
  const q = query.trim().toLowerCase();
  if (!q) return sorted.slice(0, 12);
  return sorted
    .filter((plant) => {
      const hay = [
        plant.plantName,
        plant.containerSize,
        plant.category || '',
        plant.location || '',
        plant.notes || ''
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q) || q.split(/\s+/).every((part) => hay.includes(part));
    })
    .slice(0, 12);
}

/**
 * Typeahead for linking order lines to live inventory.
 * Typing filters matches; clicking a row links. Save without a match is still allowed.
 */
export function InventoryPlantPicker({
  plants,
  plantName,
  containerSize = '',
  inventoryItemId,
  containerWeights = [],
  onChange,
  placeholder = 'e.g. Dwarf Burford Holly',
  required,
  disabled,
  className = '',
  inputClassName = '',
  applySizeOnSelect = true
}: InventoryPlantPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const linkedPlant = inventoryItemId
    ? plants.find((p) => p.id === inventoryItemId)
    : undefined;

  const matches = useMemo(
    () => filterInventoryPlants(plants, plantName),
    [plants, plantName]
  );

  useEffect(() => {
    const onDocMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  const handleTextChange = (value: string) => {
    const stillLinked =
      linkedPlant &&
      value.trim().toLowerCase() === linkedPlant.plantName.trim().toLowerCase();
    onChange({
      plantName: value,
      containerSize,
      inventoryItemId: stillLinked ? inventoryItemId : undefined
    });
    setOpen(true);
  };

  const handleSelect = (plant: InventoryPlant) => {
    const nextSize = applySizeOnSelect
      ? resolveContainerSizeId(plant.containerSize, containerWeights) || containerSize
      : containerSize;
    onChange({
      plantName: plant.plantName,
      containerSize: nextSize,
      inventoryItemId: plant.id
    });
    setOpen(false);
  };

  const clearLink = () => {
    onChange({
      plantName,
      containerSize,
      inventoryItemId: undefined
    });
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <input
        type="text"
        value={plantName}
        onChange={(e) => handleTextChange(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoComplete="off"
        className={
          inputClassName ||
          'block w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-ink-500 bg-white transition-all font-medium text-gray-800'
        }
      />

      {linkedPlant && (
        <div className="mt-1 flex items-center gap-1.5 text-[10px] font-semibold text-emerald-800">
          <Link2 className="h-3 w-3 shrink-0" />
          <span className="truncate">
            Linked · {linkedPlant.plantName} ({linkedPlant.containerSize})
            {typeof linkedPlant.quantityAvailable === 'number'
              ? ` · ${linkedPlant.quantityAvailable} avail`
              : ''}
          </span>
          <button
            type="button"
            onClick={clearLink}
            className="ml-auto inline-flex items-center gap-0.5 text-emerald-700/80 hover:text-rose-600"
            title="Unlink inventory"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {!linkedPlant && plantName.trim() && open && (
        <p className="mt-1 text-[10px] text-gray-400">
          Optional — pick a match to link inventory, or save without one.
        </p>
      )}

      {open && plants.length > 0 && (
        <div className="absolute z-30 mt-1 w-full max-h-52 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-gray-500">No inventory matches</div>
          ) : (
            matches.map((plant) => {
              const selected = plant.id === inventoryItemId;
              return (
                <button
                  key={plant.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSelect(plant)}
                  className={`w-full text-left px-3 py-2 text-xs border-b border-gray-50 last:border-0 hover:bg-ink-50 ${
                    selected ? 'bg-emerald-50' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-gray-900 truncate">{plant.plantName}</div>
                      <div className="text-[10px] text-gray-500 font-mono mt-0.5">
                        {plant.containerSize}
                        {typeof plant.quantityAvailable === 'number'
                          ? ` · ${plant.quantityAvailable} avail`
                          : ''}
                        {plant.location ? ` · ${plant.location}` : ''}
                      </div>
                    </div>
                    {selected && <Check className="h-3.5 w-3.5 text-emerald-600 shrink-0 mt-0.5" />}
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
