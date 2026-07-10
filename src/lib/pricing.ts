/** Sensible default nursery wholesale pricing based on container size. */
export function getDefaultPriceForSize(size: string): number {
  const cleanSize = size.toLowerCase().trim();
  if (cleanSize.includes('#1') || cleanSize.includes('1-gallon') || cleanSize.includes('1g')) {
    return 6.5;
  }
  if (cleanSize.includes('#3') || cleanSize.includes('3-gallon') || cleanSize.includes('3g')) {
    return 16.5;
  }
  if (cleanSize.includes('#7') || cleanSize.includes('7-gallon') || cleanSize.includes('7g')) {
    return 38;
  }
  if (cleanSize.includes('#15') || cleanSize.includes('15-gallon') || cleanSize.includes('15g')) {
    return 85;
  }
  if (cleanSize.includes('#30') || cleanSize.includes('30-gallon') || cleanSize.includes('30g')) {
    return 195;
  }
  return 15;
}
