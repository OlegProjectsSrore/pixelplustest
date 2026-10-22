import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.argv[2] || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = [];
try {
  for (const width of [360, 390, 768, 1440, 1920]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    const badResponses = [];
    const external = new Set();
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) badResponses.push([response.status(), response.url()]); });
    page.on('request', request => { if (!request.url().startsWith(origin)) external.add(request.url()); });
    await page.goto(origin, { waitUntil: 'networkidle' });
    const consent = page.locator('.fancybox__container [data-fancybox-close]').first();
    assert(await consent.isVisible(), `Consent dialog at ${width}`);
    await consent.click();
    const height = await page.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < height; y += 800) {
      await page.evaluate(y => window.scrollTo(0, y), y);
      await page.waitForTimeout(70);
    }
    await page.waitForTimeout(800);
    const audit = await page.evaluate(() => ({
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      headingCount: document.querySelectorAll('main h1, main h2').length,
      links: document.querySelectorAll('a[href]').length,
      invalidLinks: [...document.querySelectorAll('a[href],area[href]')].map(a => a.getAttribute('href')).filter(href => !/^(https?:\/\/|tel:|mailto:)/i.test(href)),
      localLinks: [...document.querySelectorAll('a[href]')].filter(a => a.origin === location.origin).map(a => a.href),
      brokenImages: [...document.images].filter(img => img.currentSrc && img.complete && !img.naturalWidth).map(img => img.currentSrc),
      formActions: [...document.forms].map(form => form.action)
    }));
    assert(audit.scrollWidth <= width, `Horizontal overflow at ${width}`);
    assert.equal(audit.headingCount, 12);
    assert.equal(audit.invalidLinks.length, 0);
    assert.equal(audit.localLinks.length, 0);
    assert.equal(audit.brokenImages.length, 0, `Broken images at ${width}: ${audit.brokenImages}`);
    assert(audit.formActions.every(action => action.startsWith('https://pixelplus.ru/')));

    await page.evaluate(() => window.scrollTo(0, 0));
    const slider = page.locator('.main-slider');
    const before = await slider.locator('.splide__slide.is-active').textContent();
    await slider.locator('.splide__arrow--next').click();
    await page.waitForTimeout(200);
    assert.notEqual(await slider.locator('.splide__slide.is-active').textContent(), before);

    if (width < 992) {
      const burger = page.locator('[data-burger]');
      await burger.click();
      assert.equal(await burger.getAttribute('aria-expanded'), 'true');
      assert(await page.locator('.page-nav').evaluate(el => el.classList.contains('-is-active')));
      await page.locator('.main-menu__dropdown--lvl1').first().click();
      assert(await page.locator('.main-menu__item--lvl1').first().evaluate(el => el.classList.contains('-is-active')));
      await page.keyboard.press('Escape');
      assert.equal(await burger.getAttribute('aria-expanded'), 'false');
    }

    const question = page.locator('.faq__question').first();
    const answer = page.locator('.faq__answer').first();
    const answerBefore = await answer.isVisible();
    await question.click();
    await page.waitForTimeout(250);
    assert.notEqual(await answer.isVisible(), answerBefore);
    await question.click();

    await page.locator('[data-filter-source="news-1"]').click();
    assert(await page.locator('[data-filter-source="news-1"]').evaluate(el => el.classList.contains('-is-active')));
    assert(await page.locator('[data-filter-target="news-0"]').evaluate(el => el.classList.contains('-is-hidden')));
    await page.locator('[data-filter-source="news-0"]').click();

    assert.deepEqual(errors, [], `JavaScript errors at ${width}`);
    assert.deepEqual(badResponses, [], `Failed resources at ${width}`);
    const unexpected = [...external].filter(url => !url.startsWith('https://yandex.ru/sprav/widget/rating-badge/'));
    assert.equal(unexpected.length, 0, `Unexpected network dependencies at ${width}: ${unexpected}`);
    report.push({ ...audit, errors, badResponses, externalRequests: [...external], interactions: 'passed' });
    console.log(`PASS ${width}px: ${audit.links} links, 12 headings, menu/slider/FAQ/news, no overflow or network errors`);
    await page.close();
  }
  await mkdir('.artifacts', { recursive: true });
  await writeFile('.artifacts/verification.json', JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
