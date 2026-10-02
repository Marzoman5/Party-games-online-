/**
 * 1. The host title screen shows a big, loaded QR code + 4-letter room code + /play join URL,
 *    at laptop (1366x768) and 4K TV (3840x2160) sizes.
 */
import { expect, test, type Page } from '@playwright/test';
import { LAPTOP, TV, collectErrors, openHost, partyState, settle, shot } from './helpers';

async function checkQr(page: Page, vp: { width: number; height: number }): Promise<void> {
  const qr = page.getByTestId('qr');
  await expect(qr).toBeVisible();
  // The image is served by the relay (/api/qr.svg) and must actually load.
  await expect.poll(() => qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 30_000 }).toBe(true);
  const src = await qr.getAttribute('src');
  expect(src).toContain('/api/qr.svg');
  const box = await qr.boundingBox();
  expect(box, 'QR bounding box').not.toBeNull();
  // Big enough to scan from the couch: at least a quarter of the screen height, fully on screen.
  expect(box!.height).toBeGreaterThanOrEqual(vp.height * 0.25);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height + 1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 1);

  await expect(page.getByTestId('room-code')).toHaveText(/^\s*[A-Z]{4}\s*$/);
  await expect(page.getByTestId('join-url')).toContainText('/play');
}

test.describe('host QR / title screen', () => {
  test('laptop 1366x768: QR visible, large, loaded; room code + join url', async ({ page }) => {
    const errs = collectErrors(page, 'host');
    const room = await openHost(page, { viewport: LAPTOP, query: 'tv=0' });
    expect(room).toMatch(/^[A-Z]{4}$/);
    await expect(page.getByTestId('screen-title')).toBeVisible();
    await checkQr(page, LAPTOP);

    const s = await partyState(page);
    expect(s.screen).toBe('title');
    expect(s.joinUrl).toContain('/play');
    expect(s.joinUrl).toContain(`room=${room}`);
    expect(s.tvMode).toBe(false);
    await expect(page.getByTestId('room-code')).toHaveText(new RegExp(room));

    // The join URL from the QR actually serves the phone app.
    const res = await page.request.get(`/play?room=${room}`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('phone-app');

    await settle(page, 3);
    await shot(page, '01-host-title-laptop.jpg');
    errs.expectNone();
  });

  test('TV 3840x2160: QR visible, large, loaded; TV mode auto-on', async ({ page }) => {
    const errs = collectErrors(page, 'host');
    const room = await openHost(page, { viewport: TV });
    expect(room).toMatch(/^[A-Z]{4}$/);
    await expect(page.getByTestId('screen-title')).toBeVisible();
    await checkQr(page, TV);
    const s = await partyState(page);
    expect(s.tvMode, 'TV mode defaults on for >=1920 px wide').toBe(true);
    expect(await page.evaluate(() => document.documentElement.classList.contains('tv'))).toBe(true);
    await settle(page, 3);
    await shot(page, '01-host-title-tv.jpg');
    errs.expectNone();
  });
});
