export const TRUCK_CAPACITIES_LBS: Record<string, number> = {
  "24' Bumper Pull": 10000,
  "28' Gooseneck": 14000,
  "30' Gooseneck": 15000,
  "32' Gooseneck": 16000,
  "36' Gooseneck": 18000,
  Hotshot: 20000,
  "26' Box": 10000,
  "26' Refer": 10000,
  "53' Semi": 45000,
  "53' Refer": 45000,
  Gooseneck: 15000,
  'Flatbed Gooseneck': 15000
};

function normalizeTruckType(truckType: string): string {
  return truckType
    .trim()
    .replace(/[''`´′]/g, "'")
    .replace(/\s+/g, ' ');
}

export function getTruckWeightCapacity(truckType?: string): number {
  if (!truckType) return 0;

  const normalized = normalizeTruckType(truckType);
  if (TRUCK_CAPACITIES_LBS[normalized]) {
    return TRUCK_CAPACITIES_LBS[normalized];
  }
  if (TRUCK_CAPACITIES_LBS[truckType]) {
    return TRUCK_CAPACITIES_LBS[truckType];
  }

  const typeLower = normalized.toLowerCase();

  // Length-based rules first (before generic "refer")
  if (typeLower.includes('53')) return 45000;
  if (typeLower.includes('26')) return 10000;

  if (typeLower.includes('refer')) return 10000;
  if (typeLower.includes('bumper')) return 10000;
  if (typeLower.includes("28'") || typeLower.includes('28')) return 14000;
  if (typeLower.includes("30'") || typeLower.includes('30')) return 15000;
  if (typeLower.includes("32'") || typeLower.includes('32')) return 16000;
  if (typeLower.includes("36'") || typeLower.includes('36')) return 18000;
  if (typeLower.includes('hotshot')) return 20000;
  if (typeLower.includes('semi')) return 45000;
  if (typeLower.includes('box')) return 10000;
  if (typeLower.includes('gooseneck')) return 15000;

  return 0;
}

export function calculateWeightPercentage(weightLbs: number, truckType?: string): number {
  const capacity = getTruckWeightCapacity(truckType);
  if (!capacity || capacity <= 0) return 0;
  return Math.round((weightLbs / capacity) * 100);
}

export function formatWeightPercentage(weightLbs: number, truckType?: string): string {
  const pct = calculateWeightPercentage(weightLbs, truckType);
  if (pct <= 0) return '';
  return `~${pct}% of trailer`;
}
