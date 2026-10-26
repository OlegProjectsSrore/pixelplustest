/* Navigation behavior for the single-page exercise. */
// Both static pages share the audit client; providers are loaded only on request.
void import('./audit-config.js?v=6014f540bd').then(() => import('./audit-client.js?v=cd81620d0f'));
document.addEventListener('DOMContentLoaded', () => {
  window.pixelplusTest = {
    numberFormat(number) { return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(number).replace(/\u00a0/g, ' '); }
  };
  if (typeof FeedbackForm === 'function') {
    document.querySelectorAll('.form--feedback').forEach(element => new FeedbackForm(element));
  }
  const original = 'https://pixelplus.ru/';
  const normalizeLinks = root => {
    root.querySelectorAll('a[href], area[href]').forEach(link => {
      const value = link.getAttribute('href');
      if (value && !/^(https?:|mailto:|tel:)/i.test(value)) {
        link.href = new URL(value, original).href;
      }
    });
  };
  normalizeLinks(document);
  new MutationObserver(() => normalizeLinks(document)).observe(document.body, { childList: true, subtree: true });

  document.querySelectorAll('.faq__question').forEach(question => {
    question.setAttribute('role', 'button');
    question.tabIndex = 0;
    question.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); question.click(); }
    });
  });

  // Continue on the original site instead of submitting to the copied backend.
  document.querySelectorAll('form[data-original-destination]').forEach(form => {
    form.addEventListener('submit', event => {
      event.preventDefault();
      window.location.assign(form.dataset.originalDestination);
    }, true);
  });
  document.querySelectorAll('.vote__star').forEach(button => {
    button.addEventListener('click', () => window.location.assign(original + '#vote_367159'));
  });

  const burger = document.querySelector('[data-burger]');
  if (burger) {
    burger.setAttribute('aria-label', 'Открыть меню');
    burger.setAttribute('aria-expanded', 'false');
    const sync = () => {
      const open = burger.classList.contains('-is-active');
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    };
    burger.addEventListener('click', sync);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && burger.classList.contains('-is-active')) {
        burger.click();
        burger.focus();
      }
    });
  }
});
