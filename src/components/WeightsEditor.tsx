import React, { useState } from 'react';
import { Settings, Weight, Check, RefreshCw } from 'lucide-react';
import { ContainerWeight } from '../types';
import { updateContainerWeight, resetToFactoryWeights } from '../lib/db';

interface WeightsEditorProps {
  containerWeights: ContainerWeight[];
  onClose: () => void;
}

export const WeightsEditor: React.FC<WeightsEditorProps> = ({ containerWeights, onClose }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tempWeight, setTempWeight] = useState<string>('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [inputError, setInputError] = useState<boolean>(false);

  const handleStartEdit = (cw: ContainerWeight) => {
    setEditingId(cw.id);
    setTempWeight(cw.weightLbs.toString());
    setInputError(false);
  };

  const handleSaveEdit = async (cw: ContainerWeight) => {
    const parsedWeight = parseFloat(tempWeight);
    if (isNaN(parsedWeight) || parsedWeight < 0) {
      setInputError(true);
      return;
    }

    setSavingId(cw.id);
    try {
      await updateContainerWeight({
        ...cw,
        weightLbs: parsedWeight
      });
      setEditingId(null);
      setInputError(false);
    } catch (err) {
      console.error('Failed to update container weight:', err);
    } finally {
      setSavingId(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, cw: ContainerWeight) => {
    if (e.key === 'Enter') {
      handleSaveEdit(cw);
    } else if (e.key === 'Escape') {
      setEditingId(null);
    }
  };

  const sortedWeights = [...containerWeights].sort((a, b) => {
    if (a.id === 'Other') return 1;
    if (b.id === 'Other') return -1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-emerald-700" />
            <h3 className="font-bold text-gray-900">Container Weights</h3>
          </div>
          <button type="button" onClick={onClose} className="text-xs font-bold text-gray-500">
            Close
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-xs text-gray-500 leading-relaxed">
            One-time setup for pot/tray weights. Changes recalculate shipping weights on active orders
            and trucks.
          </p>

          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-slate-50 p-3 rounded-xl border border-slate-150">
            {showResetConfirm ? (
              <div className="flex flex-col items-end gap-1 shrink-0 bg-red-50 p-2 rounded-lg border border-red-200 w-full sm:w-auto">
                <span className="text-[10px] font-bold text-red-800">Reset all to factory defaults?</span>
                <div className="flex gap-1">
                  <button
                    onClick={async () => {
                      try {
                        await resetToFactoryWeights();
                        setShowResetConfirm(false);
                      } catch (err) {
                        console.error(err);
                      }
                    }}
                    className="px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white font-bold text-[10px] rounded"
                  >
                    Reset
                  </button>
                  <button
                    onClick={() => setShowResetConfirm(false)}
                    className="px-2 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold text-[10px] rounded"
                  >
                    No
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowResetConfirm(true)}
                className="shrink-0 text-xs text-emerald-800 hover:text-emerald-900 bg-emerald-100 hover:bg-emerald-200 font-bold px-2.5 py-1.5 rounded-lg transition-colors border border-emerald-200 shadow-sm"
              >
                Reset to Factory Defaults
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {sortedWeights.map((cw) => {
              const isEditing = editingId === cw.id;
              const isSaving = savingId === cw.id;

              return (
                <div
                  key={cw.id}
                  className={`border rounded-xl p-3 flex items-center justify-between gap-2 transition-all ${
                    isEditing ? 'border-emerald-500 bg-emerald-50/20 shadow-sm' : 'border-gray-150 bg-gray-50/40 hover:bg-white'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-gray-800 font-sans truncate">{cw.name}</p>
                    <p className="text-[10px] text-gray-400 font-mono">Alias: {cw.id}</p>
                  </div>

                  <div className="flex items-center space-x-2 shrink-0">
                    {isEditing ? (
                      <div className="flex items-center space-x-1.5">
                        <input
                          type="number"
                          value={tempWeight}
                          onChange={(e) => setTempWeight(e.target.value)}
                          onKeyDown={(e) => handleKeyDown(e, cw)}
                          className={`w-16 px-1.5 py-1 text-xs font-bold font-mono text-center border rounded-lg bg-white focus:outline-none focus:ring-1 ${
                            inputError ? 'border-red-500 focus:ring-red-500 text-red-600' : 'border-emerald-400 focus:ring-emerald-500'
                          }`}
                          autoFocus
                          min="0"
                          step="0.5"
                        />
                        <span className="text-[10px] font-bold text-gray-400">lbs</span>
                        <button
                          onClick={() => handleSaveEdit(cw)}
                          disabled={isSaving}
                          className="p-1 bg-emerald-600 text-white hover:bg-emerald-700 rounded-md shadow-sm transition-colors"
                        >
                          {isSaving ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => handleStartEdit(cw)}
                        className="px-2 py-1 bg-white border border-gray-200 hover:border-emerald-500 rounded-lg flex items-center space-x-1 text-xs font-bold text-gray-700 hover:text-emerald-800 shadow-sm transition-all"
                      >
                        <Weight className="h-3 w-3 text-emerald-600" />
                        <span className="font-mono">{cw.weightLbs} lbs</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
