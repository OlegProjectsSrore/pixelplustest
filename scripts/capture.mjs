import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.argv[2] || 'https://pixelplus.ru/';
const output = process.argv[3] || '.reference';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4500);
    const consent = page.locator('.fancybox__container [data-fancybox-close]').first();
    if (await consent.isVisible()) await consent.click();
    const slideIndex = await page.locator('.main-slider .splide__slide').evaluateAll(slides => slides.findIndex(slide => slide.textContent.includes('Агентство')));
    const firstSlide = page.locator('.main-slider .splide__pagination__page').nth(Math.max(0, slideIndex));
    if (await firstSlide.isVisible()) await firstSlide.click();
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, `${label}-top.png`) });
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < bodyHeight; y += 700) {
      await page.evaluate(y => window.scrollTo(0, y), y);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, `${label}-full.png`), fullPage: true });
    await writeFile(path.join(output, `${label}-rendered.html`), await page.content());
    console.log(label, await page.title(), await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, height: document.body.scrollHeight })), 'errors:', errors);
    await page.close();
  }
} finally {
  await browser.close();
}
