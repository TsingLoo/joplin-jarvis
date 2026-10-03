var MAX_AUTOCOMPLETE_MESSAGE_CHARS = 20000;
var MAX_AUTOCOMPLETE_SUFFIX_CHARS = 500;
var MAX_AUTOCOMPLETE_CONTEXT_CHARS = 20000;

function getAutocompleteContextStart(textBeforeCursor, maxChars) {
  var limit = Math.max(500, Math.min(MAX_AUTOCOMPLETE_CONTEXT_CHARS, Math.floor(maxChars) || 6000));
  var start = Math.max(0, textBeforeCursor.length - limit);
  var context = textBeforeCursor.slice(start);
  var headingPattern = /(^|\n)[ \t]{0,3}#{1,2}(?!#)(?:[ \t]+[^\r\n]*)?[ \t\r]*$/gm;
  var lastHeadingStart = -1;
  var match;
  while ((match = headingPattern.exec(context)) !== null) {
    var lineStart = match.index + (match[1] ? 1 : 0);
    // The bounded slice may start halfway through a line; don't treat that as a heading.
    if (lineStart === 0 && start > 0) continue;
    lastHeadingStart = lineStart;
  }
  return start + (lastHeadingStart >= 0 ? lastHeadingStart : 0);
}

function createAutocompleteRequestId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function createAutocompleteIndicator(container, context, options, onOptionsChanged) {
  var doc = container.ownerDocument;
  if (!doc.getElementById('jarvis-autocomplete-indicator-styles')) {
    var style = doc.createElement('style');
    style.id = 'jarvis-autocomplete-indicator-styles';
    style.textContent = '\
      .jarvis-autocomplete-root{position:absolute;right:8px;bottom:6px;z-index:20;font:13px/1.4 sans-serif}\
      .jarvis-autocomplete-indicator{width:28px;height:28px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(70,70,70,.72);box-shadow:0 1px 4px rgba(0,0,0,.2);cursor:pointer}\
      .jarvis-autocomplete-indicator svg{width:18px;height:18px;overflow:visible}\
      .jarvis-autocomplete-indicator .sparkle,.jarvis-autocomplete-indicator .ring,.jarvis-autocomplete-indicator .check,.jarvis-autocomplete-indicator .slash{opacity:0;visibility:hidden;transition:opacity .22s ease,transform .22s ease,visibility 0s linear .22s}\
      .jarvis-autocomplete-indicator .sparkle{fill:#f4c95d;transform:scale(.72);transform-origin:12px 12px}\
      .jarvis-autocomplete-indicator .ring{fill:none;stroke-width:2;transform:scale(.88);transform-box:fill-box;transform-origin:center center}\
      .jarvis-autocomplete-indicator .waiting-ring{stroke:#74d7ff}\
      .jarvis-autocomplete-indicator .request-ring{stroke:#ffb86c;stroke-dasharray:24 28}\
      .jarvis-autocomplete-indicator .check{fill:none;stroke:#72e6a1;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;transform:scale(.72)}\
      .jarvis-autocomplete-indicator .slash{stroke:#ff8a80;stroke-width:2;stroke-linecap:round;transform:scale(.8)}\
      .jarvis-autocomplete-indicator[data-state=enabled] .sparkle{opacity:1;visibility:visible;transition-delay:0s;animation:jarvis-sparkle 2.8s ease-in-out infinite}\
      .jarvis-autocomplete-indicator[data-state=waiting] .waiting-ring{opacity:1;visibility:visible;transition-delay:0s;animation:jarvis-waiting 1.4s ease-in-out infinite}\
      .jarvis-autocomplete-indicator[data-state=requesting] .request-ring{opacity:1;visibility:visible;transition-delay:0s;animation:jarvis-spin .8s linear infinite}\
      .jarvis-autocomplete-indicator[data-state=ready] .check{opacity:1;visibility:visible;transition-delay:0s;animation:jarvis-check .25s ease-out both}\
      .jarvis-autocomplete-indicator[data-state=disabled] .slash{opacity:1;visibility:visible;transition-delay:0s}\
      .jarvis-autocomplete-menu{display:none;position:absolute;right:0;bottom:36px;width:235px;padding:11px 12px;border:1px solid rgba(128,128,128,.35);border-radius:9px;background:var(--joplin-background-color,#fff);color:var(--joplin-color,#222);box-shadow:0 4px 18px rgba(0,0,0,.24)}\
      .jarvis-autocomplete-root[data-open=true] .jarvis-autocomplete-menu{display:block}\
      .jarvis-autocomplete-menu-title{font-weight:600;margin-bottom:8px}\
      .jarvis-autocomplete-toggle{display:flex;align-items:center;gap:7px;margin-bottom:10px;cursor:pointer}\
      .jarvis-autocomplete-context-label{display:flex;justify-content:space-between;gap:8px;margin-bottom:4px}\
      .jarvis-autocomplete-context-range{width:100%;margin:0}\
      .jarvis-autocomplete-context{background:rgba(151,211,139,.12);text-decoration:underline;text-decoration-color:rgba(119,190,105,.72);text-decoration-thickness:1px;text-underline-offset:2px}\
      @keyframes jarvis-sparkle{0%,100%{transform:scale(.92)}50%{transform:scale(1.06)}}\
      @keyframes jarvis-waiting{0%,100%{transform:scale(.96)}50%{transform:scale(1.04)}}\
      @keyframes jarvis-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}\
      @keyframes jarvis-check{from{transform:scale(.72)}to{transform:scale(1)}}\
      @media(prefers-reduced-motion:reduce){.jarvis-autocomplete-indicator *{animation:none!important;transition:none!important}}';
    doc.head.appendChild(style);
  }
  var root = doc.createElement('div');
  root.className = 'jarvis-autocomplete-root';
  var element = doc.createElement('button');
  element.type = 'button';
  element.className = 'jarvis-autocomplete-indicator';
  element.setAttribute('aria-label', '自动补全设置');
  element.setAttribute('aria-haspopup', 'dialog');
  element.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ring waiting-ring" cx="12" cy="12" r="8.5"/><circle class="ring request-ring" cx="12" cy="12" r="8.5"/><path class="sparkle" d="M12 2.8l2.25 6.95L21.2 12l-6.95 2.25L12 21.2l-2.25-6.95L2.8 12l6.95-2.25L12 2.8z"/><path class="check" d="M6.5 12.4l3.6 3.4 7.6-8"/><path class="slash" d="M5 5l14 14"/></svg>';
  var menu = doc.createElement('div');
  menu.className = 'jarvis-autocomplete-menu';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', '自动补全设置');
  menu.innerHTML = '<div class="jarvis-autocomplete-menu-title">自动补全</div><label class="jarvis-autocomplete-toggle"><input class="jarvis-autocomplete-enabled" type="checkbox">启用自动补全</label><label class="jarvis-autocomplete-context-label"><span>上下文</span><span><output class="jarvis-autocomplete-context-value"></output> 字符</span></label><input class="jarvis-autocomplete-context-range" type="range" min="500" max="20000" step="500">';
  root.appendChild(element);
  root.appendChild(menu);
  container.appendChild(root);
  var enabledInput = menu.querySelector('.jarvis-autocomplete-enabled');
  var contextRange = menu.querySelector('.jarvis-autocomplete-context-range');
  var contextValue = menu.querySelector('.jarvis-autocomplete-context-value');
  var currentState = 'enabled';
  var pinned = false;
  var hideTimer = null;
  var titles = {
    enabled: 'Jarvis 自动补全已开启',
    waiting: 'Jarvis 自动补全：等待停笔',
    requesting: 'Jarvis 自动补全：正在生成',
    ready: 'Jarvis 自动补全：建议就绪，按 Tab 接受',
    disabled: 'Jarvis 自动补全已禁用',
  };
  function render() {
    var displayedState = options.enabled ? currentState : 'disabled';
    element.dataset.state = displayedState;
    element.title = titles[displayedState];
    element.setAttribute('aria-expanded', root.dataset.open === 'true' ? 'true' : 'false');
    enabledInput.checked = options.enabled;
    contextRange.disabled = !options.enabled;
    contextRange.value = String(options.contextChars);
    contextValue.value = String(options.contextChars);
  }
  function setOptions(result) {
    var previousEnabled = options.enabled;
    var previousContextChars = options.contextChars;
    if (result && typeof result.enabled === 'boolean') options.enabled = result.enabled;
    if (result && Number.isFinite(result.contextChars)) options.contextChars = result.contextChars;
    render();
    if (previousEnabled !== options.enabled || previousContextChars !== options.contextChars) onOptionsChanged();
  }
  function refreshOptions() {
    context.postMessage({ type: 'jarvis.autocomplete.getOptions' }).then(setOptions).catch(function() {});
  }
  function onDocumentPointerDown(event) {
    if (pinned && !root.contains(event.target)) {
      pinned = false;
      root.dataset.open = 'false';
      render();
    }
  }
  doc.addEventListener('pointerdown', onDocumentPointerDown);
  function closeSoon() {
    if (pinned) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function() { hideTimer = null; root.dataset.open = 'false'; render(); }, 350);
  }
  root.addEventListener('mouseenter', function() {
    if (hideTimer) clearTimeout(hideTimer);
    root.dataset.open = 'true';
    render();
  });
  root.addEventListener('mouseleave', closeSoon);
  root.addEventListener('focusin', function() { root.dataset.open = 'true'; render(); refreshOptions(); });
  element.addEventListener('click', function() {
    pinned = !pinned;
    root.dataset.open = pinned ? 'true' : 'false';
    render();
    if (pinned) refreshOptions();
  });
  menu.addEventListener('pointerdown', function(event) { event.stopPropagation(); });
  menu.addEventListener('mousedown', function(event) { event.stopPropagation(); });
  menu.addEventListener('click', function(event) { event.stopPropagation(); });
  enabledInput.addEventListener('change', function() {
    options.enabled = enabledInput.checked;
    render();
    onOptionsChanged();
    context.postMessage({ type: 'jarvis.autocomplete.setEnabled', enabled: options.enabled }).then(setOptions).catch(refreshOptions);
  });
  contextRange.addEventListener('input', function() { contextValue.value = contextRange.value; });
  contextRange.addEventListener('change', function() {
    options.contextChars = Number(contextRange.value);
    render();
    onOptionsChanged();
    context.postMessage({ type: 'jarvis.autocomplete.setContextChars', contextChars: options.contextChars }).then(setOptions).catch(refreshOptions);
  });
  render();
  refreshOptions();
  return {
    set: function(nextState) {
      currentState = nextState;
      render();
    },
    remove: function() {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      doc.removeEventListener('pointerdown', onDocumentPointerDown);
      root.remove();
    },
  };
}


module.exports = {
  MAX_AUTOCOMPLETE_MESSAGE_CHARS: MAX_AUTOCOMPLETE_MESSAGE_CHARS,
  MAX_AUTOCOMPLETE_SUFFIX_CHARS: MAX_AUTOCOMPLETE_SUFFIX_CHARS,
  getAutocompleteContextStart: getAutocompleteContextStart,
  createAutocompleteRequestId: createAutocompleteRequestId,
  createAutocompleteIndicator: createAutocompleteIndicator,
};
