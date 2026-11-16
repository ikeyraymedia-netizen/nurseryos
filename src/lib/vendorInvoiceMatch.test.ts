import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findMatchingInventoryPlants, normalizeContainerSize } from './inventoryMatch';
import { findMatchingVendors, resolveInvoiceVendorName } from './vendorMatch';
import type { InventoryPlant, Vendor } from '../types';

const JACK_RABBIT_INVOICE = `
https://jackrabbitnursery.com/
INVOICE
Bill to
Bayou State Plant Co., LLC
Ship To
Bayou State Plant Co., LLC
Sales Rep Todd Morrow
Description Size Qty Price Extended
Echinacea purpurea 'Magnus' 1gal 95 $3.25 $308.75
Panicum virgatum - Switch Grass 3gal 65 $7.00 $455.00
Schizachyrium scoparium Little Bluestem 1gal 25 $3.75 $93.75
`;

function vendor(name: string): Vendor {
  return { id: name, name, createdAt: '', updatedAt: '' };
}

function plant(plantName: string, containerSize: string): InventoryPlant {
  return {
    id: `${plantName}|${containerSize}`,
    plantName,
    containerSize,
    quantityAvailable: 1,
    chemicals: [],
    dateCreated: '',
    dateUpdated: ''
  };
}

describe('Jack Rabbit invoice vendor', () => {
  const names = ['Jack Rabbit Nursery', 'Jackrabbit Girl', 'Waylon Jack', 'Bayou State Plant Co'];

  it('uses the website when the scan reads the bill-to nursery as the vendor', () => {
    const resolved = resolveInvoiceVendorName(
      'Bayou State Plant Co., LLC',
      JACK_RABBIT_INVOICE,
      names,
      'Bayou State Plant Co'
    );
    assert.equal(resolved, 'Jack Rabbit Nursery');
    const match = findMatchingVendors(resolved, names.map(vendor));
    assert.equal(match.best?.name, 'Jack Rabbit Nursery');
    assert.equal(match.confidence, 'exact');
  });

  it('treats Jackrabbit Nursery as the same vendor as Jack Rabbit Nursery', () => {
    const match = findMatchingVendors('Jackrabbit Nursery', [vendor('Jack Rabbit Nursery')]);
    assert.equal(match.best?.name, 'Jack Rabbit Nursery');
    assert.equal(match.confidence, 'exact');
  });
});

describe('Jack Rabbit invoice plants', () => {
  const inventory = [
    plant('Panicum Virgatum - Switchgrass', '#3'),
    plant('Panicum Virgatum - Dallas Blue', '#3'),
    plant('Schizachyrium Scoparium - Little Bluestem', '#1'),
    plant('Schizachyrium Scoparium - Blaze Little Bluestem', '#1'),
    plant('Echinacea Purpurea - Magnus', '#1')
  ];

  it('reads 1gal and 3gal as #1 and #3', () => {
    assert.equal(normalizeContainerSize('1gal'), '#1');
    assert.equal(normalizeContainerSize('3gal'), '#3');
  });

  it('matches invoice wording to the inventory plant, not a more specific cultivar', () => {
    const switchGrass = findMatchingInventoryPlants(
      inventory,
      'Panicum virgatum - Switch Grass',
      '3gal'
    );
    assert.equal(switchGrass[0]?.plantName, 'Panicum Virgatum - Switchgrass');

    const bluestem = findMatchingInventoryPlants(
      inventory,
      'Schizachyrium scoparium Little Bluestem',
      '1gal'
    );
    assert.equal(bluestem[0]?.plantName, 'Schizachyrium Scoparium - Little Bluestem');

    const magnus = findMatchingInventoryPlants(
      inventory,
      "Echinacea purpurea 'Magnus'",
      '1gal'
    );
    assert.equal(magnus[0]?.plantName, 'Echinacea Purpurea - Magnus');

    const dallas = findMatchingInventoryPlants(inventory, 'Panicum Dallas Blues', '3gal');
    assert.equal(dallas[0]?.plantName, 'Panicum Virgatum - Dallas Blue');
  });
});
