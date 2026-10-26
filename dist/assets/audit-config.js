// Public connection settings only. Provider credentials remain on the Worker.
window.PIXELPLUS_AUDIT_CONFIG = Object.freeze({
  // Public sessions are enabled on the Worker; provider keys stay server-side.
  publicSessionsEnabled: true,
  apiBaseUrl: 'https://pixelplus-ai.rudiskiyoleg.workers.dev',
  turnstileEnabled: false,
  turnstileSiteKey: '0x4AAAAAAFhfOxQMNL2gKzND',
  voiceProvider: 'openai',
});
