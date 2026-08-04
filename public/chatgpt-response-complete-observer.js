(function () {
  const STATE_KEY = '__gvChatGptResponseObserverState';
  const SOURCE = 'gpt-voyager-chatgpt-response-observer';
  const CONTROL_SOURCE = 'gpt-voyager-chatgpt-response-observer-control';
  const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
  const GENERATION_PATH = /^\/backend-api\/(?:f\/)?conversation\/?$/i;

  const existing = window[STATE_KEY];
  if (existing) {
    existing.active = true;
    return;
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;

  const state = { active: true, nextRequestId: 1 };

  function getUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href);
      if (input instanceof URL) return input;
      if (input && typeof input.url === 'string') return new URL(input.url, location.href);
    } catch {}
    return null;
  }

  function getMethod(input, init) {
    return String(init?.method || input?.method || 'GET').toUpperCase();
  }

  function isGenerationRequest(input, init) {
    const url = getUrl(input);
    return (
      !!url &&
      getMethod(input, init) === 'POST' &&
      CHATGPT_HOSTS.has(url.hostname.toLowerCase()) &&
      GENERATION_PATH.test(url.pathname)
    );
  }

  function post(type, payload) {
    try {
      window.postMessage({ source: SOURCE, type, payload }, location.origin);
    } catch {}
  }

  function drainResponse(response, requestId, startedAt) {
    let reader;
    try {
      reader = response?.clone?.().body?.getReader?.();
    } catch {}

    if (!reader) {
      post('request-untracked', { requestId, duration: Date.now() - startedAt });
      return;
    }

    const readNext = function () {
      reader.read().then(
        function (chunk) {
          if (!chunk.done) {
            readNext();
            return;
          }
          post('request-complete', {
            requestId,
            duration: Date.now() - startedAt,
            ok: response?.ok === true,
          });
        },
        function () {
          post('request-error', { requestId, duration: Date.now() - startedAt });
        },
      );
    };
    readNext();
  }

  function wrappedFetch(input, init) {
    if (!state.active || !isGenerationRequest(input, init)) {
      return originalFetch.apply(this, arguments);
    }

    const requestId = `${Date.now().toString(36)}-${state.nextRequestId++}`;
    const startedAt = Date.now();
    post('request-start', {
      requestId,
      pageUrl: location.href,
      pageTitle: document.title,
    });

    return originalFetch.apply(this, arguments).then(
      function (response) {
        drainResponse(response, requestId, startedAt);
        return response;
      },
      function (error) {
        post('request-error', { requestId, duration: Date.now() - startedAt });
        throw error;
      },
    );
  }

  function handleControl(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CONTROL_SOURCE || data.type !== 'uninstall') return;
    state.active = false;
    if (window.fetch === wrappedFetch) {
      window.fetch = originalFetch;
      window.removeEventListener('message', handleControl);
      delete window[STATE_KEY];
    }
  }

  state.wrappedFetch = wrappedFetch;
  window[STATE_KEY] = state;
  window.addEventListener('message', handleControl);
  window.fetch = wrappedFetch;
})();
