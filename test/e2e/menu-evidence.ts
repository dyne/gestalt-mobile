/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/** Capture geometry and the real viewport before asserting, including on failure. */
export async function captureMenuTarget(
  page: Page,
  target: Locator,
  testInfo: TestInfo,
  name: string,
  options: { control?: boolean; focused?: boolean } = {},
) {
  const geometry = await target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const panel = document.getElementById('configuration-panel')!;
    const panelBox = panel.getBoundingClientRect();
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const containers = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(parentStyle.overflowX)) {
        clip.left = Math.max(clip.left, bounds.left + parent.clientLeft);
        clip.right = Math.min(clip.right, bounds.left + parent.clientLeft + parent.clientWidth);
      }
      if (/(auto|scroll|hidden|clip)/.test(parentStyle.overflowY)) {
        clip.top = Math.max(clip.top, bounds.top + parent.clientTop);
        clip.bottom = Math.min(clip.bottom, bounds.top + parent.clientTop + parent.clientHeight);
      }
      if (/(auto|scroll|hidden|clip)/.test(parentStyle.overflow))
        containers.push({
          tag: parent.tagName,
          className: parent.className,
          rect: bounds.toJSON(),
          clientWidth: parent.clientWidth,
          clientHeight: parent.clientHeight,
          scrollTop: parent.scrollTop,
        });
      // Native top-layer popovers escape clipping by body/HTML ancestors.
      if (parent === panel) break;
    }
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      rect: box.toJSON(),
      clip,
      containers,
      clipped: Math.max(
        0,
        clip.left - box.left,
        box.right - clip.right,
        clip.top - box.top,
        box.bottom - clip.bottom,
      ),
      focus: element === document.activeElement,
      visibleFocus: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0,
      hit: !!hit && element.contains(hit),
      contentFits: element.scrollWidth <= element.clientWidth + 0.5,
      panelFits:
        panelBox.left >= -0.5 &&
        panelBox.right <= innerWidth + 0.5 &&
        panelBox.top >= -0.5 &&
        panelBox.bottom <= innerHeight + 0.5,
    };
  });
  await testInfo.attach(`${name}-geometry`, {
    body: JSON.stringify(geometry),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  expect(geometry.clipped, JSON.stringify(geometry)).toBeLessThanOrEqual(0.5);
  expect(geometry.hit, JSON.stringify(geometry)).toBe(true);
  expect(geometry.contentFits, JSON.stringify(geometry)).toBe(true);
  expect(geometry.panelFits, JSON.stringify(geometry)).toBe(true);
  if (options.control) {
    expect(geometry.rect.width).toBeGreaterThanOrEqual(44);
    expect(geometry.rect.height).toBeGreaterThanOrEqual(44);
  }
  if (options.focused) {
    expect(geometry.focus).toBe(true);
    expect(geometry.visibleFocus).toBe(true);
  }
  return geometry;
}
