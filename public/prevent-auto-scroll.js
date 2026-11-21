(function () {
  'use strict';
  if (window.__gvPreventAutoScrollInstalled) return;
  window.__gvPreventAutoScrollInstalled = true;

  console.log('[GPT-Voyager] Prevent auto scroll script loaded');

  const BRIDGE_ID = 'gv-prevent-auto-scroll-bridge';
  function isEnabled() {
    const bridge = document.getElementById(BRIDGE_ID);
    return bridge && bridge.dataset.enabled === 'true';
  }

  function getScrollTop(el) {
    if (el === window) return document.documentElement.scrollTop || document.body.scrollTop;
    return el.scrollTop;
  }

  function getScrollHeight(el) {
    if (el === window) return document.documentElement.scrollHeight || document.body.scrollHeight;
    return el.scrollHeight;
  }

  function getClientHeight(el) {
    if (el === window) return document.documentElement.clientHeight || window.innerHeight;
    return el.clientHeight;
  }

  function isScrolledUp(el) {
    const st = getScrollTop(el);
    const sh = getScrollHeight(el);
    const ch = getClientHeight(el);
    // If not scrollable or very small
    if (sh <= ch + 10) return false;
    return sh - st - ch > 150;
  }

  function verticalArgument(args) {
    if (args.length === 1 && args[0] && typeof args[0] === 'object') return args[0].top;
    if (args.length >= 2) return args[1];
    return undefined;
  }

  function shouldBlockPosition(el, targetY) {
    if (targetY === undefined) return false;
    const current = getScrollTop(el);
    if (!(targetY > current)) return false;
    if (el instanceof Element && el.classList.contains('thread-scroll-container')) {
      // When ChatGPT prepends or remeasures virtual rows, it adds their height
      // to scrollTop so the same paragraph stays under the reader's eyes.
      // Only suppress a request to follow the conversation all the way down.
      const bottom = current < 0 ? 0 : getScrollHeight(el) - getClientHeight(el);
      return bottom - current > 150 && targetY >= bottom - 1;
    }
    return isScrolledUp(el);
  }

  function shouldBlockScrollTo(el, args) {
    return isEnabled() && shouldBlockPosition(el, verticalArgument(args));
  }

  function shouldBlockScrollBy(el, args) {
    if (!isEnabled()) return false;
    const delta = verticalArgument(args);
    return delta > 0 && shouldBlockPosition(el, getScrollTop(el) + Number(delta));
  }

  const originalWindowScrollTo = window.scrollTo;
  window.scrollTo = function (...args) {
    if (shouldBlockScrollTo(window, args)) return;
    return originalWindowScrollTo.apply(this, args);
  };

  const originalWindowScrollBy = window.scrollBy;
  window.scrollBy = function (...args) {
    if (shouldBlockScrollBy(window, args)) return;
    return originalWindowScrollBy.apply(this, args);
  };

  const originalElementScrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (...args) {
    if (shouldBlockScrollTo(this, args)) return;
    return originalElementScrollTo.apply(this, args);
  };

  const originalElementScrollBy = Element.prototype.scrollBy;
  Element.prototype.scrollBy = function (...args) {
    if (shouldBlockScrollBy(this, args)) return;
    return originalElementScrollBy.apply(this, args);
  };

  const originalScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...args) {
    if (isEnabled()) {
      let ancestor = this.parentElement;
      let blocked = false;
      while (ancestor) {
        if (ancestor.scrollHeight > ancestor.clientHeight) {
          if (isScrolledUp(ancestor)) {
            const rect = this.getBoundingClientRect();
            if (rect.top > (window.innerHeight || document.documentElement.clientHeight)) {
              blocked = true;
            } else if (rect.bottom > ancestor.getBoundingClientRect().bottom) {
              blocked = true;
            }
            break;
          }
        }
        ancestor = ancestor.parentElement;
      }
      if (!ancestor && isScrolledUp(window)) {
        const rect = this.getBoundingClientRect();
        if (rect.top > (window.innerHeight || document.documentElement.clientHeight)) {
          blocked = true;
        }
      }

      if (blocked) return;
    }
    return originalScrollIntoView.apply(this, args);
  };

  const originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollTop',
  );
  if (originalScrollTopDescriptor) {
    Object.defineProperty(Element.prototype, 'scrollTop', {
      get: originalScrollTopDescriptor.get,
      set: function (value) {
        if (isEnabled() && shouldBlockPosition(this, value)) return;
        return originalScrollTopDescriptor.set.call(this, value);
      },
    });
  }
})();
