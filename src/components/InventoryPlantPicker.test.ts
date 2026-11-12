import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { placePlantMenu } from './InventoryPlantPicker.tsx';

const phone = { offsetTop: 0, offsetLeft: 0, width: 390, height: 700 };

describe('plant menu placement', () => {
  it('opens under the field when there is room', () => {
    const box = placePlantMenu({ top: 200, bottom: 240, left: 16, width: 300 }, phone);
    assert.equal(box.top, 244);
    assert.equal(box.left, 16);
    assert.ok(box.top + box.maxHeight <= phone.height);
  });

  it('stays next to the field when the keyboard has scrolled the page', () => {
    const box = placePlantMenu(
      { top: 180, bottom: 220, left: 16, width: 300 },
      { offsetTop: 420, offsetLeft: 0, width: 390, height: 380 }
    );
    const inputTop = 180 + 420;
    assert.ok(box.top >= 420);
    assert.ok(box.top + box.maxHeight <= 420 + 380);
    assert.ok(Math.abs(box.top + box.maxHeight - inputTop) <= 8 || Math.abs(box.top - (220 + 420)) <= 8);
  });

  it('opens above the field when the keyboard leaves no room below', () => {
    const box = placePlantMenu(
      { top: 300, bottom: 340, left: 12, width: 280 },
      { offsetTop: 0, offsetLeft: 0, width: 390, height: 360 }
    );
    assert.ok(box.top + box.maxHeight <= 300);
    assert.ok(box.top >= 0);
  });
});
