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
  if (cleanSize.includes('#45') || cleanSize.includes('45-gallon') || cleanSize.includes('45g')) {
    return 275;
  }
  if (cleanSize.includes('#65') || cleanSize.includes('65-gallon') || cleanSize.includes('65g')) {
    return 375;
  }
  if (cleanSize.includes('#100') || cleanSize.includes('100-gallon') || cleanSize.includes('100g')) {
    return 550;
  }
  return 15;
}
