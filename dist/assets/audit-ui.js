/**
 * Presentation layer for the preliminary audit. The controller owns requests,
 * session state, time, provider connections and report delivery.
 * User interactions call handlers; render() never submits or starts an action.
 */
let viewCount = 0;

const PHASE_TEXT = {
  idle: 'Выберите удобный способ ответить на вопросы.',
  loading: 'Подготавливаем опрос…',
  interview: 'Ответьте на вопрос — это поможет подготовить предварительный аудит.',
  paused: 'Опрос на паузе. Можно продолжить, когда будете готовы.',
  closing: 'Завершаем сбор информации…',
  preparing: 'Спасибо за предоставленную информацию, сейчас вам предоставим отчёт предварительного аудита.',
  ready: 'Ваш PDF-отчёт готов.',
  failed: 'Не удалось продолжить. Попробуйте ещё раз.',
  unavailable: 'Сейчас опрос недоступен.',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, variant = 'secondary') {
  const node = element('button', `audit-button audit-button--${variant}`, text);
  node.type = 'button';
  return node;
}

function safeText(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {Object} handlers Interaction callbacks supplied by the controller.
 * @returns {Object} View methods and an unmodified challengeElement mount point.
 *
 * question.answer_mode === 'multiple' enables checkboxes; otherwise radio.
 * question.can_skip === true enables onSkip(). Status text is already localized
 * by the controller. Text drafts are cleared only by clearDraft()/setDraft().
 */
export function createAuditView(handlers = {}) {
  const prefix = `audit-${++viewCount}`;
  let destroyed = false;
  let opener = null;
  let questionKey = '';
  let messageKey = '';
  let selectedIds = new Set();
  const mobile = matchMedia('(max-width: 600px)');
  let previousOverflow = '';
  let scrollLocked = false;
  let model = {
    mode: 'chat', phase: 'idle', question: null, messages: [],
    remaining_seconds: null, busy: false, capabilities: {},
  };

  const dialog = element('dialog', 'audit-dialog');
  dialog.setAttribute('aria-label', 'Чат с AI-помощником');

  const header = element('header', 'audit-header');
  const closeButton = button('×', 'close');
  closeButton.setAttribute('aria-label', 'Закрыть окно опроса');
  const time = element('p', 'audit-time');
  time.setAttribute('aria-live', 'off');

  const body = element('div', 'audit-body');
  const channels = element('div', 'audit-channels');
  channels.setAttribute('role', 'group');
  channels.setAttribute('aria-label', 'Способ ответить');
  const chatButton = button('Чат', 'channel');
  const voiceButton = button('', 'channel');
  voiceButton.classList.add('audit-button--voice');
  voiceButton.setAttribute('aria-label', 'Голос');
  voiceButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7 12.8 12.8 0 0 0 .7 2.8 2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5 12.8 12.8 0 0 0 2.8.7 2 2 0 0 1 1.8 2.1Z"/></svg>';
  channels.append(chatButton, voiceButton);
  header.append(channels, time, closeButton);

  const status = element('p', 'audit-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const voiceStatus = element('p', 'audit-voice-status');
  voiceStatus.setAttribute('role', 'status');
  const notice = element('p', 'audit-notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const error = element('p', 'audit-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;

  // Owned by the controller: render() never replaces or empties this node.
  const challengeElement = element('div', 'audit-challenge');

  const messages = element('div', 'audit-messages');
  messages.setAttribute('role', 'log');
  messages.setAttribute('aria-label', 'История опроса');
  messages.setAttribute('aria-live', 'polite');
  messages.setAttribute('aria-relevant', 'additions text');

  const questionSection = element('section', 'audit-question');
  questionSection.setAttribute('aria-labelledby', `${prefix}-question`);
  const questionTitle = element('h3', 'audit-question-title');
  questionTitle.id = `${prefix}-question`;
  const selectionForm = element('form', 'audit-selection-form');
  const optionFieldset = element('fieldset', 'audit-options');
  const optionLegend = element('legend', 'audit-option-legend');
  const optionList = element('div', 'audit-option-list');
  optionFieldset.append(optionLegend, optionList);
  const selectionActions = element('div', 'audit-selection-actions');
  const selectionSubmit = button('Ответить', 'primary');
  selectionSubmit.type = 'submit';
  const skipButton = button('Пропустить вопрос', 'quiet');
  selectionActions.append(selectionSubmit, skipButton);
  selectionForm.append(optionFieldset, selectionActions);
  questionSection.append(questionTitle, selectionForm);

  const textForm = element('form', 'audit-text-form');
  const textLabel = element('label', 'audit-label', 'Ваш ответ');
  textLabel.htmlFor = `${prefix}-draft`;
  const draft = element('textarea', 'audit-textarea');
  draft.id = `${prefix}-draft`;
  draft.rows = 2;
  draft.placeholder = 'Напишите ответ своими словами';
  draft.setAttribute('aria-describedby', `${prefix}-text-hint`);
  const textActions = element('div', 'audit-text-actions');
  const textHint = element('p', 'audit-hint', 'Enter — отправить, Shift + Enter — новая строка');
  textHint.id = `${prefix}-text-hint`;
  const textSubmit = button('Отправить', 'primary');
  textSubmit.type = 'submit';
  textActions.append(textHint, textSubmit);
  textForm.append(textLabel, draft, textActions);

  const readySection = element('section', 'audit-ready');
  const reportLabel = element('p', 'audit-report-format', 'PDF');
  const reportTitle = element('h3', 'audit-report-title', 'ПРЕДВАРИТЕЛЬНЫЙ АУДИТ');
  const downloadButton = button('Скачать PDF', 'primary');
  readySection.append(reportLabel, reportTitle, downloadButton);

  const emailForm = element('form', 'audit-email-form');
  const emailLabel = element('label', 'audit-label', 'Отправить отчёт на почту');
  emailLabel.htmlFor = `${prefix}-email`;
  const emailRow = element('div', 'audit-email-row');
  const email = element('input', 'audit-input');
  email.id = `${prefix}-email`;
  email.type = 'email';
  email.name = 'audit-email';
  email.autocomplete = 'email';
  email.inputMode = 'email';
  email.required = true;
  email.placeholder = 'name@example.ru';
  const emailSubmit = button('Отправить PDF', 'secondary');
  emailSubmit.type = 'submit';
  emailRow.append(email, emailSubmit);
  const consentLabel = element('label', 'audit-consent');
  const consent = element('input', 'audit-checkbox');
  consent.type = 'checkbox';
  consent.required = true;
  const consentText = element('span', '', 'Согласен на отправку отчёта на указанный адрес электронной почты.');
  consentLabel.append(consent, consentText);
  const emailStatus = element('p', 'audit-email-status');
  emailStatus.setAttribute('role', 'status');
  emailForm.append(emailLabel, emailRow, consentLabel, emailStatus);
  readySection.append(emailForm);

  const recovery = element('div', 'audit-recovery');
  const retryButton = button('Попробовать ещё раз', 'primary');
  recovery.append(retryButton);

  const footer = element('footer', 'audit-footer');
  const sessionActions = element('div', 'audit-session-actions');
  const pauseButton = button('На паузу');
  const resumeButton = button('Продолжить опрос', 'primary');
  const finishButton = button('Завершить опрос', 'quiet');
  sessionActions.append(pauseButton, resumeButton, finishButton);
  const footerNote = element('p', 'audit-footer-note', 'Рекомендации будут в PDF после опроса.');
  footer.append(textForm, sessionActions, footerNote);

  const greeting = element('p', 'audit-greeting', 'Здравствуйте! Помогу разобраться, что мешает росту вашего бизнеса. Ответьте на вопросы — по итогам вы получите PDF с предварительным аудитом. Опрос займёт до 15 минут.');
  body.append(greeting, status, voiceStatus, notice, error, challengeElement,
    messages, questionSection, readySection, recovery);
  dialog.append(header, body, footer);
  document.body.append(dialog);

  function call(name, ...args) {
    if (!destroyed && typeof handlers[name] === 'function') handlers[name](...args);
  }

  function canAnswer() {
    return model.phase === 'interview' && model.mode === 'chat' && !model.busy && model.capabilities?.chat !== false;
  }

  function updateAnswerButtons() {
    textSubmit.disabled = !canAnswer() || !draft.value.trim();
    selectionSubmit.disabled = !canAnswer() || !selectedIds.size;
  }

  function submitText() {
    const text = draft.value.trim();
    if (canAnswer() && text) call('onText', text);
    // The controller clears the draft after receiving acknowledgement.
  }

  function close() {
    if (destroyed || !dialog.open) return;
    dialog.close();
    unlockScroll();
    opener?.setAttribute('aria-expanded', 'false');
    if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
  }

  function unlockScroll() {
    if (scrollLocked) document.body.style.overflow = previousOverflow;
    scrollLocked = false;
  }
  function showPanel() {
    const pageX = window.scrollX, pageY = window.scrollY;
    if (mobile.matches) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      scrollLocked = true;
      dialog.setAttribute('aria-modal', 'true');
      dialog.showModal();
    } else {
      dialog.setAttribute('aria-modal', 'false');
      dialog.show();
    }
    window.scrollTo({ left: pageX, top: pageY, behavior: 'instant' });
  }
  function changeViewport() {
    if (!dialog.open) return;
    const focused = document.activeElement;
    dialog.close();
    unlockScroll();
    showPanel();
    focused?.focus({ preventScroll: true });
  }
  mobile.addEventListener('change', changeViewport);
  function escape(event) {
    if (dialog.open && !mobile.matches && event.key === 'Escape') {
      event.preventDefault();
      userClose();
    }
  }
  document.addEventListener('keydown', escape);

  function userClose() {
    close();
    call('onClose');
  }

  closeButton.addEventListener('click', userClose);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    userClose();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || !mobile.matches) return;
    const focusable = [...dialog.querySelectorAll('button, input, textarea, select, a[href], iframe, [tabindex]')]
      .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  chatButton.addEventListener('click', () => call('onChannel', 'chat'));
  voiceButton.addEventListener('click', () => call('onChannel', 'voice'));
  pauseButton.addEventListener('click', () => call('onPause'));
  resumeButton.addEventListener('click', () => call('onResume'));
  finishButton.addEventListener('click', () => call('onFinish'));
  downloadButton.addEventListener('click', () => call('onDownload'));
  retryButton.addEventListener('click', () => call('onRetry'));
  skipButton.addEventListener('click', () => {
    if (canAnswer() && model.question?.can_skip === true) call('onSkip');
  });
  selectionForm.addEventListener('submit', event => {
    event.preventDefault();
    if (canAnswer() && selectedIds.size) call('onSelection', [...selectedIds]);
  });
  draft.addEventListener('input', updateAnswerButtons);
  draft.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitText();
    }
  });
  textForm.addEventListener('submit', event => {
    event.preventDefault();
    submitText();
  });
  email.addEventListener('input', () => { consent.checked = false; });
  emailForm.addEventListener('submit', event => {
    event.preventDefault();
    if (model.phase !== 'ready' || model.busy || !model.capabilities?.email) return;
    if (!consent.checked || !emailForm.reportValidity()) return;
    call('onEmail', email.value.trim());
  });

  function render(nextModel) {
    if (destroyed) return;
    const previousQuestionId = model.question?.id;
    const previousPhase = model.phase;
    const nearEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 64;
    model = { ...model, ...nextModel, capabilities: nextModel?.capabilities ?? model.capabilities };
    const { phase, busy, capabilities } = model;
    const interviewing = phase === 'interview';
    const paused = phase === 'paused';
    const ready = phase === 'ready';
    const completed = ['closing', 'preparing', 'ready'].includes(phase);
    dialog.dataset.phase = phase;
    body.setAttribute('aria-busy', String(Boolean(busy)));

    status.textContent = model.launchPending
      ? 'Аудит готовится к запуску. Начать опрос пока нельзя. Пожалуйста, зайдите позже.'
      : PHASE_TEXT[phase] || PHASE_TEXT.unavailable;
    status.hidden = phase === 'interview' && !busy;
    greeting.hidden = Boolean(model.messages?.length) || completed;
    channels.hidden = completed || !['interview', 'paused'].includes(phase);
    voiceStatus.textContent = safeText(model.voice_status);
    voiceStatus.hidden = model.mode !== 'voice' || !voiceStatus.textContent || completed;
    error.textContent = safeText(model.error);
    error.hidden = !error.textContent;
    chatButton.setAttribute('aria-pressed', String(model.mode === 'chat'));
    voiceButton.setAttribute('aria-pressed', String(model.mode === 'voice'));
    chatButton.disabled = busy || !capabilities.chat || (model.mode === 'chat' && phase !== 'idle');
    voiceButton.disabled = busy || !capabilities.voice || (model.mode === 'voice' && phase !== 'idle');

    const seconds = model.remaining_seconds;
    const hasTime = Number.isFinite(seconds) && seconds >= 0 && (interviewing || paused);
    time.hidden = !hasTime;
    if (hasTime) {
      const remaining = Math.ceil(seconds);
      time.textContent = `Осталось ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
    }

    const nextMessages = Array.isArray(model.messages) ? model.messages : [];
    const nextMessageKey = JSON.stringify(nextMessages);
    const messagesChanged = nextMessageKey !== messageKey;
    if (messagesChanged) {
      messages.replaceChildren(...nextMessages.map(message => {
        const user = message.role === 'user';
        const item = element('div', `audit-message${user ? ' audit-message--user' : ''}`);
        const role = element('span', 'audit-message-role', user ? 'Вы' : 'Ассистент');
        const text = element('p', 'audit-message-text', safeText(message.text));
        item.append(role, text);
        return item;
      }));
      messageKey = nextMessageKey;
    }
    messages.hidden = !nextMessages.length || ready;

    const question = model.question;
    const options = Array.isArray(question?.options) ? question.options : [];
    const nextQuestionKey = JSON.stringify(question);
    if (nextQuestionKey !== questionKey) {
      if (previousQuestionId !== question?.id) selectedIds.clear();
      selectedIds = new Set([...selectedIds].filter(id => options.some(option => option.id === id)));
      questionTitle.textContent = safeText(question?.text);
      const multiple = question?.answer_mode === 'multiple';
      if (!multiple && selectedIds.size > 1) selectedIds = new Set([[...selectedIds][0]]);
      optionLegend.textContent = multiple ? 'Выберите один или несколько ответов' : 'Выберите один ответ';
      optionList.replaceChildren(...options.map(option => {
        const label = element('label', 'audit-option');
        const input = element('input', 'audit-option-input');
        input.type = multiple ? 'checkbox' : 'radio';
        input.name = `${prefix}-answer`;
        input.value = option.id;
        input.checked = selectedIds.has(option.id);
        input.addEventListener('change', () => {
          if (!multiple) selectedIds.clear();
          if (input.checked) selectedIds.add(option.id);
          else selectedIds.delete(option.id);
          updateAnswerButtons();
        });
        label.append(input, element('span', 'audit-option-text', safeText(option.text)));
        return label;
      }));
      questionKey = nextQuestionKey;
    }
    questionSection.hidden = !question || !interviewing;
    selectionForm.hidden = model.mode !== 'chat' || (!options.length && question?.can_skip !== true);
    optionFieldset.hidden = !options.length;
    optionFieldset.disabled = !canAnswer();
    selectionSubmit.hidden = !options.length;
    skipButton.hidden = question?.can_skip !== true;
    skipButton.disabled = !canAnswer();
    textForm.hidden = model.mode !== 'chat' || completed || paused;
    draft.disabled = !canAnswer();
    updateAnswerButtons();

    readySection.hidden = !ready;
    downloadButton.disabled = Boolean(busy);
    emailForm.hidden = !capabilities.email;
    email.disabled = busy || !capabilities.email;
    consent.disabled = busy || !capabilities.email;
    emailSubmit.disabled = busy || !capabilities.email;
    emailStatus.textContent = safeText(model.email_status);
    emailStatus.hidden = !emailStatus.textContent;
    if (previousPhase === 'ready' && !ready) consent.checked = false;

    recovery.hidden = model.launchPending || (phase !== 'failed' && phase !== 'unavailable' && !error.textContent);
    retryButton.disabled = Boolean(busy);
    pauseButton.hidden = !interviewing;
    pauseButton.disabled = busy || !capabilities.pause;
    resumeButton.hidden = !paused;
    resumeButton.disabled = busy || !capabilities.resume;
    finishButton.hidden = !interviewing && !paused;
    finishButton.disabled = busy || !capabilities.finish;
    sessionActions.hidden = !interviewing && !paused;
    if (dialog.open && previousPhase !== 'interview' && interviewing && model.mode === 'chat' && dialog.contains(document.activeElement)) draft.focus({ preventScroll: true });
    const hasNewQuestion = previousQuestionId && previousQuestionId !== question?.id;
    if (dialog.open && (hasNewQuestion || (messagesChanged && nearEnd))) {
      requestAnimationFrame(() => {
        if (destroyed) return;
        if (hasNewQuestion && !questionSection.hidden) body.scrollTop = Math.max(0, questionSection.offsetTop - 16);
        else if (nearEnd) body.scrollTop = body.scrollHeight;
      });
    }
    footerNote.textContent = ready ? 'Отчёт содержит предварительную оценку по вашим ответам.' : 'Рекомендации будут в PDF после опроса.';
  }

  render(model);

  return {
    challengeElement,
    open() {
      if (destroyed || dialog.open) return;
      opener = document.activeElement;
      showPanel();
      opener?.setAttribute('aria-expanded', 'true');
      (canAnswer() ? draft : closeButton).focus({ preventScroll: true });
    },
    close,
    render,
    notify(message) {
      if (destroyed) return;
      notice.textContent = safeText(message);
      notice.hidden = !notice.textContent;
    },
    getDraft() { return draft.value; },
    setDraft(text) {
      if (destroyed) return;
      draft.value = safeText(text);
      updateAnswerButtons();
    },
    clearDraft() {
      if (destroyed) return;
      draft.value = '';
      updateAnswerButtons();
    },
    destroy() {
      if (destroyed) return;
      close();
      destroyed = true;
      mobile.removeEventListener('change', changeViewport);
      document.removeEventListener('keydown', escape);
      dialog.remove();
    },
  };
}
