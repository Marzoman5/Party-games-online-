/**
 * 9. One-player keyboard race (no phones): ENTER on the title -> solo menus -> keyboard
 *    navigation -> race -> hold ArrowUp moves the kart -> finish -> results.
 */
import { expect, test } from '@playwright/test';
import { collectErrors, gameState, openHost, partyState, settle, shot, sleep, waitEnginePhase } from './helpers';

test('1-player keyboard race works end to end', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = collectErrors(page, 'host');
  await openHost(page);
  await expect(page.getByTestId('screen-title')).toBeVisible();

  await page.keyboard.press('Enter');
  await waitEnginePhase(page, ['soloMenu'], 30_000);
  expect((await partyState(page)).soloActive).toBe(true);
  // Party overlays get out of the way.
  await expect(page.getByTestId('screen-title')).toHaveCount(0);
  // The ENTER that opens solo mode must not also confirm character select (regression check).
  await sleep(1500);
  await expect(page.locator('.panel-tracks.active')).toHaveCount(0);
  await expect(page.locator('.panel-chars.active')).toBeVisible({ timeout: 15_000 });
  await settle(page, 3);
  await shot(page, '09-host-solo-character-select-laptop.jpg');

  // Pick the 2nd racer, confirm; then confirm track select.
  await page.keyboard.press('ArrowRight');
  await sleep(600);
  await page.keyboard.press('Enter');
  await expect(page.locator('.panel-tracks.active')).toBeVisible({ timeout: 30_000 });
  await settle(page, 3);
  await shot(page, '09-host-solo-track-select-laptop.jpg');
  await sleep(600);
  await page.keyboard.press('Enter');

  await waitEnginePhase(page, ['loading', 'intro', 'countdown', 'racing'], 60_000);
  await waitEnginePhase(page, ['racing'], 180_000);
  const g0 = await gameState(page);
  expect(g0.viewports).toBe(1);
  expect(g0.karts.filter((k) => k.human).length).toBe(1);
  const start = g0.karts[0];

  await page.keyboard.down('ArrowUp');
  try {
    await expect
      .poll(async () => {
        const k = (await gameState(page)).karts[0];
        return Math.hypot(k.x - start.x, k.z - start.z);
      }, { timeout: 90_000, intervals: [1000] })
      .toBeGreaterThan(3);
    expect((await gameState(page)).karts[0].speed).toBeGreaterThan(1);
    await shot(page, '09-host-solo-racing-laptop.jpg');
  } finally {
    await page.keyboard.up('ArrowUp');
  }

  await page.evaluate(() => (window as unknown as { __game: { finishAll(): void } }).__game.finishAll());
  await waitEnginePhase(page, ['results'], 60_000);
  // The engine's own solo results screen.
  await expect(page.locator('#ui .screen.results:not(.hidden)')).toBeVisible({ timeout: 30_000 });
  await settle(page, 3);
  await shot(page, '09-host-solo-results-laptop.jpg');
  expect((await partyState(page)).soloActive).toBe(true);
  errs.expectNone();
});
