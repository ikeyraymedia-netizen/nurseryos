import {
  isSpreadsheetInventoryUpload,
  parseInventoryCsvText,
  parseInventorySpreadsheetArrayBuffer,
  type SpreadsheetInventoryItem
} from '../src/lib/inventorySpreadsheet';

export type ParsedInventoryItem = SpreadsheetInventoryItem & {
  recentChemicals?: Array<{ chemicalName: string; appliedAt?: string; notes?: string }>;
};

export { isSpreadsheetInventoryUpload, parseInventoryCsvText };

export async function parseInventorySpreadsheetBuffer(
  buffer: Buffer,
  fileName?: string
): Promise<ParsedInventoryItem[]> {
  return parseInventorySpreadsheetArrayBuffer(buffer, fileName);
}
