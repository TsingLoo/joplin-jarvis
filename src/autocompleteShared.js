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

/**
 * The Jarvis indicator in the corner of the editor.
 *
 * It is a switch, not a settings panel: one click turns autocomplete off for
 * the note being edited, another turns it back on, and the state follows the
 * note (the host stores it). Context size is a plugin setting, so it is not
 * repeated here.
 *
 * There is deliberately no custom tooltip: the indicator changes state while
 * typing, so a tooltip that follows it would rewrite its own text under the
 * pointer. The browser's own `title` tooltip appears on hover and is stable.
 */
function createAutocompleteIndicator(container, context, options, onOptionsChanged) {
  var doc = container.ownerDocument;
  if (!doc.getElementById('jarvis-autocomplete-indicator-styles')) {
    var style = doc.createElement('style');
    style.id = 'jarvis-autocomplete-indicator-styles';
    style.textContent = '\
      .jarvis-autocomplete-root{position:absolute;right:8px;bottom:6px;z-index:20;font:13px/1.4 sans-serif;display:flex;flex-direction:column;align-items:center;padding-top:34px;padding-left:8px;padding-right:8px}\
      .jarvis-autocomplete-indicator{width:28px;height:28px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:0 0 auto;background:rgba(70,70,70,.72);box-shadow:0 1px 4px rgba(0,0,0,.2);cursor:pointer}\
      .jarvis-autocomplete-indicator svg{width:18px;height:18px;overflow:visible}\
      .jarvis-autocomplete-indicator .sparkle,.jarvis-autocomplete-indicator .ring,.jarvis-autocomplete-indicator .check,.jarvis-autocomplete-indicator .slash{opacity:0;visibility:hidden;transition:opacity .22s ease,transform .22s ease,visibility 0s linear .22s;transform-box:fill-box;transform-origin:center}\
      .jarvis-autocomplete-indicator .sparkle{fill:#f4c95d;transform:scale(.72)}\
      .jarvis-autocomplete-indicator .ring{fill:none;stroke-width:2;transform:scale(.88)}\
      .jarvis-autocomplete-indicator .waiting-ring{stroke:#74d7ff}\
      .jarvis-autocomplete-indicator .request-ring{stroke:#ffb86c;stroke-dasharray:24 28}\
      .jarvis-autocomplete-indicator .check{fill:none;stroke:#72e6a1;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;transform:scale(.72)}\
      .jarvis-autocomplete-indicator .slash{stroke:#ff8a80;stroke-width:2;stroke-linecap:round;transform:scale(.8)}\
      .jarvis-autocomplete-indicator[data-state=enabled] .sparkle{opacity:1;visibility:visible;transition-delay:0s;animation:jarvis-sparkle 2.8s ease-in-out infinite}\
      .jarvis-autocomplete-indicator[data-state=disabled] .slash{opacity:1;visibility:visible;transition-delay:0s}\
      .jarvis-autocomplete-indicator[data-state=excluded]{cursor:default}\
      .jarvis-autocomplete-indicator[data-state=excluded] .slash{opacity:1;visibility:visible;transition-delay:0s;stroke:#a8a8a8}\
      .jarvis-autocomplete-exclude{width:24px;height:24px;margin-bottom:10px;padding:0;border:1px solid rgba(255,138,128,.55);border-radius:50%;display:flex;align-items:center;justify-content:center;flex:0 0 auto;background:rgba(70,70,70,.85);cursor:pointer}\
      .jarvis-autocomplete-exclude svg{width:14px;height:14px}\
      .jarvis-autocomplete-exclude:hover{background:rgba(120,70,70,.92)}\
      .jarvis-autocomplete-exclude[hidden]{display:none}\
      .jarvis-autocomplete-context{background:rgba(151,211,139,.12);text-decoration:underline;text-decoration-color:rgba(119,190,105,.72);text-decoration-thickness:1px;text-underline-offset:2px}\
      @keyframes jarvis-sparkle{0%,100%{transform:scale(.92)}50%{transform:scale(1.06)}}\
      @media(prefers-reduced-motion:reduce){.jarvis-autocomplete-indicator *{animation:none!important;transition:none!important}}';
    doc.head.appendChild(style);
  }
  var root = doc.createElement('div');
  root.className = 'jarvis-autocomplete-root';
  var excludeButton = doc.createElement('button');
  excludeButton.type = 'button';
  excludeButton.className = 'jarvis-autocomplete-exclude';
  // A struck-through eye: the note stops being looked at. The button carries no
  // text, so the meaning has to be in the icon and in the hover title.
  excludeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" fill="none" stroke="#ffd9d4" stroke-width="1.6"/><circle cx="12" cy="12" r="2.6" fill="#ffd9d4"/><path d="M4.5 19.5l15-15" stroke="#ffd9d4" stroke-width="1.8" stroke-linecap="round"/></svg>';
  excludeButton.title = '排除此笔记：加上 jarvis-exclude 标签，Jarvis 将不再读取它';
  excludeButton.setAttribute('aria-label', '将这篇笔记排除出 Jarvis');
  excludeButton.hidden = true;
  var element = doc.createElement('button');
  element.type = 'button';
  element.className = 'jarvis-autocomplete-indicator';
  element.setAttribute('aria-label', '自动补全');
  element.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="ring waiting-ring" cx="12" cy="12" r="8.5"/><circle class="ring request-ring" cx="12" cy="12" r="8.5"/><path class="sparkle" d="M12 2.8l2.25 6.95L21.2 12l-6.95 2.25L12 21.2l-2.25-6.95L2.8 12l6.95-2.25L12 2.8z"/><path class="check" d="M6.5 12.4l3.6 3.4 7.6-8"/><path class="slash" d="M5 5l14 14"/></svg>';
  root.appendChild(excludeButton);
  root.appendChild(element);
  container.appendChild(root);
  /** False until the first getOptions answer arrives; until then a click has nothing to toggle. */
  var optionsReady = false;
  /** Reveal timer for the exclude button; see setExcludeRevealed(). */
  var excludeRevealTimer = null;
  /** The note every message is about; the host keeps the switch per note. */
  var noteId = null;
  function isExcluded() {
    return options.excluded === true;
  }
  /**
   * The new value a click selects.
   *
   * For a note excluded by a tag, `enabled` is the note's own preference, so a
   * click flips it. Everywhere else it is the value in effect, and the note's
   * preference becomes its opposite.
   */
  function desiredEnabled() {
    return !options.enabled;
  }
  /**
   * A tag is part of the note, so the user can lift it themselves; a notebook
   * exclusion or the trash is not something the note's own switch should
   * override, so those stay unsendable.
   */
  function canToggleExclusion() {
    return options.exclusionReason === 'tag';
  }
  function blockedByExclusion() {
    return isExcluded() && !canToggleExclusion();
  }
  /**
   * The hover text. It names the actual reason, because "excluded" is not one
   * situation: a tagged note is excluded by something the user can change in
   * Joplin right now, while a notebook exclusion is a Jarvis setting and the
   * trash is not a setting at all.
   */
  function currentTitle() {
    if (isExcluded()) {
      if (canToggleExclusion()) {
        return '此笔记已排除 Jarvis（jarvis-exclude 标签）'
          + (options.enabled ? '，点击可关闭自动补全' : '，点击可开启自动补全')
          + '；移除标签后才会生效';
      }
      if (options.exclusionReason === 'folder') {
        return '此笔记所在的笔记本已排除 Jarvis。要使用自动补全，请对笔记本运行「Include notebook in Jarvis」';
      }
      if (options.exclusionReason === 'deleted') {
        return '此笔记在回收站中，Jarvis 自动补全不可用';
      }
      if (options.exclusionReason === 'conflict') {
        return '这是冲突笔记，Jarvis 自动补全不可用';
      }
      return '此笔记已排除 Jarvis，自动补全不可用';
    }
    return options.enabled
      ? 'Jarvis 自动补全已开启，点击关闭（仅对当前笔记生效）'
      : 'Jarvis 自动补全已关闭，点击开启（仅对当前笔记生效）';
  }
  function render() {
    var state = isExcluded() ? 'excluded' : (options.enabled ? 'enabled' : 'disabled');
    element.dataset.state = state;
    // Kept short and stable so hovering never reflows the tooltip
    element.title = currentTitle();
    element.setAttribute('aria-pressed', options.enabled && !isExcluded() ? 'true' : 'false');
    element.setAttribute('aria-disabled', blockedByExclusion() ? 'true' : 'false');
    // Offering to exclude a note that is already excluded (or is not usable at
    // all) would be noise
    if (!optionsReady || isExcluded()) {
      hideExcludeButton();
    }
  }
  function hideExcludeButton() {
    if (excludeRevealTimer) {
      clearTimeout(excludeRevealTimer);
      excludeRevealTimer = null;
    }
    excludeButton.hidden = true;
  }
  /**
   * Reveal the exclude button shortly after the pointer arrives, not with it:
   * the two buttons sit side by side, so appearing at once would put a
   * one-click, tag-writing action under a pointer that only meant to hover, or
   * was on its way to the on/off switch.
   */
  function setExcludeRevealed(revealed) {
    if (excludeRevealTimer) {
      clearTimeout(excludeRevealTimer);
      excludeRevealTimer = null;
    }
    if (!revealed) {
      excludeButton.hidden = true;
      return;
    }
    if (!optionsReady || isExcluded()) return;
    excludeRevealTimer = setTimeout(function() {
      excludeRevealTimer = null;
      if (optionsReady && !isExcluded()) {
        excludeButton.hidden = false;
      }
    }, 250);
  }
  root.addEventListener('mouseenter', function() {
    setExcludeRevealed(true);
  });
  root.addEventListener('mouseleave', function() {
    setExcludeRevealed(false);
  });
  root.addEventListener('focusin', function() {
    setExcludeRevealed(true);
  });
  root.addEventListener('focusout', function() {
    setExcludeRevealed(false);
  });
  function setOptions(result) {
    var previousEnabled = options.enabled;
    var previousExcluded = options.excluded;
    var previousReason = options.exclusionReason;
    if (result && typeof result.enabled === 'boolean') options.enabled = result.enabled;
    if (result && Number.isFinite(result.contextChars)) options.contextChars = result.contextChars;
    if (result && typeof result.excluded === 'boolean') options.excluded = result.excluded;
    if (result && typeof result.exclusionReason === 'string') options.exclusionReason = result.exclusionReason;
    if (result && typeof result.noteOverride === 'boolean') options.noteOverride = result.noteOverride;
    optionsReady = true;
    render();
    if (previousEnabled !== options.enabled || previousExcluded !== options.excluded
      || previousReason !== options.exclusionReason) {
      onOptionsChanged();
    }
  }
  function refreshOptions(nextNoteId) {
    if (typeof nextNoteId === 'string') noteId = nextNoteId;
    context.postMessage({ type: 'jarvis.autocomplete.getOptions', noteId: noteId })
      .then(setOptions).catch(function() {});
  }
  element.addEventListener('click', function(event) {
    event.stopPropagation();
    // Nothing to toggle before the note's state is known, and a note excluded
    // by its notebook (or sitting in the trash) has no switch here
    if (!optionsReady || blockedByExclusion()) return;
    // Invert what the button shows, not what `enabled` happens to say: on a
    // tagged note the stored preference is already "wanted", and a click has to
    // undo that rather than re-apply it
    var next = desiredEnabled();
    options.enabled = next;
    // The switch now expresses a choice for this note, which is what lets it
    // stand on its own for a tagged note
    options.noteOverride = true;
    // Optimistic; the host answers with what it stored
    render();
    onOptionsChanged();
    context.postMessage({ type: 'jarvis.autocomplete.setEnabled', enabled: next, noteId: noteId })
      .then(setOptions).catch(function() { refreshOptions(); });
  });
  excludeButton.addEventListener('click', function(event) {
    event.stopPropagation();
    if (!optionsReady || isExcluded()) return;
    // The host writes the tag and answers with the note's state, which turns
    // the indicator into the grey, unusable slash
    excludeButton.disabled = true;
    context.postMessage({ type: 'jarvis.autocomplete.excludeNote', noteId: noteId })
      .then(function(result) {
        excludeButton.disabled = false;
        setOptions(result);
        hideExcludeButton();
      })
      .catch(function() {
        excludeButton.disabled = false;
        hideExcludeButton();
        refreshOptions();
      });
  });
  render();
  refreshOptions();
  return {
    remove: function() {
      if (excludeRevealTimer) clearTimeout(excludeRevealTimer);
      root.remove();
    },
    // The content scripts still report their per-keystroke phases through the
    // factory's callback, but the indicator no longer has a state to set beyond
    // what `render()` derives from the options, so there is nothing to expose.
    refreshOptions: refreshOptions,
  };
}

module.exports = {
  MAX_AUTOCOMPLETE_MESSAGE_CHARS: MAX_AUTOCOMPLETE_MESSAGE_CHARS,
  MAX_AUTOCOMPLETE_SUFFIX_CHARS: MAX_AUTOCOMPLETE_SUFFIX_CHARS,
  getAutocompleteContextStart: getAutocompleteContextStart,
  createAutocompleteRequestId: createAutocompleteRequestId,
  createAutocompleteIndicator: createAutocompleteIndicator,
};
