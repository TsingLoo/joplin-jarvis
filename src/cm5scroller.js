// modified from: https://github.com/cqroot/joplin-outline/blob/main/src/codeMirrorScroller.js
var autocomplete = require('./autocompleteShared');
var MAX_AUTOCOMPLETE_MESSAGE_CHARS = autocomplete.MAX_AUTOCOMPLETE_MESSAGE_CHARS;
var MAX_AUTOCOMPLETE_SUFFIX_CHARS = autocomplete.MAX_AUTOCOMPLETE_SUFFIX_CHARS;
var getAutocompleteContextStart = autocomplete.getAutocompleteContextStart;
var createAutocompleteRequestId = autocomplete.createAutocompleteRequestId;
var createAutocompleteIndicator = autocomplete.createAutocompleteIndicator;

function plugin(CodeMirror, context) {
  if (CodeMirror.cm6) { return; }
  var options = { enabled: true, contextChars: 6000 };

  CodeMirror.defineInitHook(function(cm) {
    var timer = null;
    var requestVersion = 0;
    var pendingPosition = null;
    var suggestionMark = null;
    var contextMarks = [];
    var suggestionText = '';
    var lastDocumentText = cm.getValue();
    var pendingDocumentText = null;
    var activeRequestId = null;
    var destroyed = false;
    var suppressNextChange = false;
    var status = createAutocompleteIndicator(cm.getWrapperElement(), context, options, function() {
      clearTimer();
      clearSuggestion();
      setStatus(options.enabled ? 'enabled' : 'disabled');
    });

    function setStatus(state) {
      status.set(state);
    }
    setStatus(options.enabled ? 'enabled' : 'disabled');

    function clearTimer() {
      requestVersion++;
      if (timer) clearTimeout(timer);
      timer = null;
      pendingPosition = null;
      pendingDocumentText = null;
      clearContextMarks();
      if (activeRequestId) {
        var requestId = activeRequestId;
        activeRequestId = null;
        context.postMessage({ type: 'jarvis.inlineAutocomplete.cancel', requestId: requestId }).catch(function() {});
      }
    }

    function clearContextMarks() {
      contextMarks.forEach(function(mark) { mark.clear(); });
      contextMarks = [];
    }

    function showContextMarks(prefix, suffix, cursorIndex) {
      clearContextMarks();
      var contextStart = cursorIndex - prefix.length + getAutocompleteContextStart(prefix, options.contextChars);
      var contextEnd = cursorIndex;
      if (contextEnd > contextStart) {
        contextMarks.push(cm.markText(cm.posFromIndex(contextStart), cm.posFromIndex(contextEnd), { className: 'jarvis-autocomplete-context' }));
      }
      var boundedSuffixLength = Math.min(suffix.length, MAX_AUTOCOMPLETE_SUFFIX_CHARS);
      if (suffix.slice(0, boundedSuffixLength).trim()) {
        contextMarks.push(cm.markText(cm.posFromIndex(cursorIndex), cm.posFromIndex(cursorIndex + boundedSuffixLength), { className: 'jarvis-autocomplete-context' }));
      }
    }

    function clearSuggestion() {
      if (suggestionMark) suggestionMark.clear();
      suggestionMark = null;
      suggestionText = '';
    }

    function acceptSuggestion() {
      if (!suggestionMark || !suggestionText) return CodeMirror.Pass;
      var position = suggestionMark.find();
      if (!position) {
        clearSuggestion();
        return CodeMirror.Pass;
      }
      var text = suggestionText;
      clearTimer();
      clearSuggestion();
      setStatus('enabled');
      suppressNextChange = true;
      cm.replaceRange(text, position, position, '+input');
      cm.setCursor(CodeMirror.Pos(position.line, position.ch + text.length));
      return true;
    }

    cm.addKeyMap({ Tab: acceptSuggestion });

    cm.on('changes', function(editor, changes) {
      var currentDocumentText = editor.getValue();
      if (suppressNextChange) {
        suppressNextChange = false;
        lastDocumentText = currentDocumentText;
        clearTimer();
        clearSuggestion();
        return;
      }
      var hasInsertedText = Array.isArray(changes)
        ? changes.some(function(change) {
          var insertedText = Array.isArray(change.text) ? change.text.join('\n') : String(change.text || '');
          return insertedText.trim().length > 0;
        })
        : currentDocumentText.length > lastDocumentText.length;
      if (!hasInsertedText) {
        clearTimer();
        clearSuggestion();
        lastDocumentText = currentDocumentText;
        setStatus(options.enabled ? 'enabled' : 'disabled');
        return;
      }
      var baselineDocumentText = pendingDocumentText !== null ? pendingDocumentText : lastDocumentText;
      clearTimer();
      clearSuggestion();
      pendingDocumentText = baselineDocumentText;
      lastDocumentText = currentDocumentText;
      if (!options.enabled) {
        pendingDocumentText = null;
        setStatus('disabled');
        return;
      }
      if (editor.somethingSelected()) {
        pendingDocumentText = null;
        setStatus('enabled');
        return;
      }
      var cursor = editor.getCursor('head');
      var prefix = editor.getRange({ line: 0, ch: 0 }, cursor).slice(-MAX_AUTOCOMPLETE_MESSAGE_CHARS);
      if (prefix.trim().length < 8) {
        pendingDocumentText = null;
        setStatus('enabled');
        return;
      }
      setStatus('waiting');
      var version = requestVersion;
      var docText = currentDocumentText;
      var cursorIndex = editor.indexFromPos(cursor);
      var suffix = docText.slice(cursorIndex, cursorIndex + MAX_AUTOCOMPLETE_SUFFIX_CHARS);
      pendingPosition = editor.indexFromPos(cursor);
      timer = setTimeout(function() {
        timer = null;
        if (pendingDocumentText !== null && editor.getValue() === pendingDocumentText) {
          pendingDocumentText = null;
          setStatus('enabled');
          return;
        }
        pendingDocumentText = null;
        var requestPosition = editor.getCursor('head');
        if (destroyed || editor.somethingSelected() || editor.indexFromPos(requestPosition) !== pendingPosition) {
          setStatus('enabled');
          return;
        }
        setStatus('requesting');
        var requestId = createAutocompleteRequestId();
        activeRequestId = requestId;
        showContextMarks(prefix, suffix, pendingPosition);
        context.postMessage({ type: 'jarvis.inlineAutocomplete', prefix: prefix, suffix: suffix, requestId: requestId, contextChars: options.contextChars }).then(function(result) {
          if (activeRequestId === requestId) activeRequestId = null;
          if (destroyed || version !== requestVersion) return;
          clearContextMarks();
          if (!result || !result.text) {
            setStatus('enabled');
            return;
          }
          if (editor.getValue() !== docText || editor.indexFromPos(editor.getCursor('head')) !== pendingPosition || editor.somethingSelected()) {
            setStatus('enabled');
            return;
          }
          var widget = document.createElement('span');
          widget.className = 'jarvis-inline-suggestion';
          widget.textContent = result.text;
          widget.style.cssText = 'opacity:.48; pointer-events:none; white-space:pre-wrap;';
          suggestionText = result.text;
          suggestionMark = editor.setBookmark(requestPosition, { widget: widget, insertLeft: false });
          setStatus('ready');
        }).catch(function(error) {
          if (activeRequestId === requestId) activeRequestId = null;
          if (destroyed || version !== requestVersion) return;
          clearContextMarks();
          setStatus('enabled');
          console.debug('Jarvis: inline autocomplete request failed', error);
        });
      }, 800);
    });

    cm.on('cursorActivity', function(editor) {
      if (suggestionMark) {
        clearSuggestion();
        setStatus('enabled');
        return;
      }
      if ((timer || activeRequestId) && pendingPosition !== null && editor.indexFromPos(editor.getCursor('head')) !== pendingPosition) {
        clearTimer();
        setStatus('enabled');
      }
    });

    cm.on('blur', function() {
      clearTimer();
      clearSuggestion();
      setStatus(options.enabled ? 'enabled' : 'disabled');
    });
    cm.on('unload', function() {
      destroyed = true;
      clearTimer();
      clearSuggestion();
      status.remove();
    });
  });

  CodeMirror.defineExtension('scrollToJarvisLine', function scrollToJarvisLine(lineno) {
    // temporary fix: sometimes the first coordinate is incorrect,
    // resulting in a difference about +- 10 px,
    // call the scroll function twice fixes the problem.
    this.scrollTo(null, this.charCoords({ line: lineno, ch: 0 }, 'local').top);
    this.scrollTo(null, this.charCoords({ line: lineno, ch: 0 }, 'local').top);
  });

  CodeMirror.commands['jarvis.replaceSelectionAround'] = function jarvisReplaceSelectionAround(cm, text) {
    const ranges = cm.listSelections();
    const insertText = typeof text === 'string' ? text : String(text ?? '');
    const replacements = ranges.map(() => insertText);
    cm.replaceSelections(replacements, 'around');
  };
}

module.exports = {
  default(context) {
    return {
      plugin(CodeMirror) {
        plugin(CodeMirror, context);
      },
    };
  },
};
