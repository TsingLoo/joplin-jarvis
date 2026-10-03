import type { ContentScriptContext, MarkdownEditorContentScriptModule } from 'api/types';
import { EditorSelection, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
import {
	MAX_AUTOCOMPLETE_MESSAGE_CHARS,
	MAX_AUTOCOMPLETE_SUFFIX_CHARS,
	getAutocompleteContextStart,
	createAutocompleteRequestId,
	createAutocompleteIndicator,
} from './autocompleteShared';

const setInlineSuggestion = StateEffect.define<{ from: number; text: string } | null>();
const setAutocompleteContext = StateEffect.define<Array<{ from: number; to: number }> | null>();
class InlineSuggestionWidget extends WidgetType {
	constructor(readonly text: string) { super(); }
	toDOM(): HTMLElement {
		const span = document.createElement('span');
		span.className = 'jarvis-inline-suggestion';
		span.textContent = this.text;
		span.style.cssText = 'opacity:.48; pointer-events:none; white-space:pre-wrap;';
		return span;
	}
	eq(other: InlineSuggestionWidget): boolean { return this.text === other.text; }
}

const inlineSuggestionField = StateField.define<{ from: number; text: string } | null>({
	create: () => null,
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setInlineSuggestion)) return effect.value;
		}
		if (transaction.docChanged || transaction.selection !== undefined) return null;
		return value;
	},
	provide: field => EditorView.decorations.from(field, suggestion => suggestion
		? Decoration.set(Decoration.widget({
			widget: new InlineSuggestionWidget(suggestion.text),
			side: 1,
		}).range(suggestion.from))
		: Decoration.none),
});

const autocompleteContextField = StateField.define<Array<{ from: number; to: number }> | null>({
	create: () => null,
	update(value, transaction) {
		if (transaction.docChanged || transaction.selection) return null;
		for (const effect of transaction.effects) {
			if (effect.is(setAutocompleteContext)) return effect.value;
		}
		return value;
	},
	provide: field => EditorView.decorations.from(field, ranges => ranges?.length
		? Decoration.set(ranges
			.filter(range => range.to > range.from)
			.map(range => Decoration.mark({ class: 'jarvis-autocomplete-context' }).range(range.from, range.to)), true)
		: Decoration.none),
});

function createInlineAutocompletePlugin(context: ContentScriptContext, editorControl: any, options: { enabled: boolean; contextChars: number }) {
	return ViewPlugin.fromClass(class {
		private timer: ReturnType<typeof setTimeout> | null = null;
		private requestVersion = 0;
		private suppressNextChange = false;
		private destroyed = false;
		private pendingDocumentText: string | null = null;
		private activeRequestId: string | null = null;
		private waitingForCompositionEnd = false;
		private status: ReturnType<typeof createAutocompleteIndicator>;
		private compositionEndHandler = () => {
			if (!this.waitingForCompositionEnd) return;
			this.waitingForCompositionEnd = false;
			if (!options.enabled) {
				this.setStatus('disabled');
				return;
			}
			if (!this.view.state.selection.main.empty) {
				this.pendingDocumentText = null;
				this.setStatus('enabled');
				return;
			}
			this.scheduleSuggestion();
		};

		constructor(readonly view: EditorView) {
			this.status = createAutocompleteIndicator(view.dom, context, options, () => this.optionsChanged());
			view.dom.addEventListener('compositionend', this.compositionEndHandler);
			this.setStatus(options.enabled ? 'enabled' : 'disabled');
		}

		private setStatus(state: 'enabled' | 'disabled' | 'waiting' | 'requesting' | 'ready') {
			this.status.set(state);
		}

		private optionsChanged() {
			this.cancelPending();
			this.pendingDocumentText = null;
			this.waitingForCompositionEnd = false;
			this.clearRequestContext();
			const suggestion = this.view.state.field(inlineSuggestionField, false);
			if (suggestion) this.view.dispatch({ effects: setInlineSuggestion.of(null) });
			this.setStatus(options.enabled ? 'enabled' : 'disabled');
		}

		update(update: any) {
			if (!options.enabled) {
				if (update.docChanged || update.selectionSet) {
					this.cancelPending();
					this.pendingDocumentText = null;
					this.waitingForCompositionEnd = false;
				}
				this.setStatus('disabled');
				return;
			}
			if (this.suppressNextChange && update.docChanged) {
				this.suppressNextChange = false;
				this.cancelPending();
				this.pendingDocumentText = null;
				this.waitingForCompositionEnd = false;
				this.setStatus('enabled');
				return;
			}
			if (update.docChanged || update.selectionSet) {
				this.cancelPending();
				if (update.docChanged) {
					this.waitingForCompositionEnd = false;
					let hasInsertedText = false;
					update.changes.iterChanges((_fromA: number, _toA: number, _fromB: number, _toB: number, inserted: any) => {
						if (inserted.toString().trim().length > 0) hasInsertedText = true;
					});
					if (!hasInsertedText) {
						this.pendingDocumentText = null;
						this.setStatus('enabled');
						return;
					}
					if (this.pendingDocumentText === null) this.pendingDocumentText = update.startState.doc.toString();
					if (this.view.composing) {
						this.waitingForCompositionEnd = true;
						this.setStatus('waiting');
					} else if (this.view.state.selection.main.empty) {
						this.setStatus('waiting');
						this.scheduleSuggestion();
					} else {
						this.pendingDocumentText = null;
						this.setStatus('enabled');
					}
				} else {
					this.pendingDocumentText = null;
					this.waitingForCompositionEnd = false;
					this.setStatus('enabled');
				}
			}
		}

		private scheduleSuggestion() {
			if (this.timer) clearTimeout(this.timer);
			this.timer = setTimeout(() => { void this.requestSuggestion(); }, 800);
		}

		private cancelPending() {
			this.requestVersion++;
			if (this.timer) clearTimeout(this.timer);
			this.timer = null;
			if (this.activeRequestId) {
				const requestId = this.activeRequestId;
				this.activeRequestId = null;
				void context.postMessage({ type: 'jarvis.inlineAutocomplete.cancel', requestId }).catch(() => {});
			}
		}

		private clearRequestContext() {
			if (this.view.state.field(autocompleteContextField, false)?.length) {
				this.view.dispatch({ effects: setAutocompleteContext.of(null) });
			}
		}

		private async requestSuggestion() {
			this.timer = null;
			if (!options.enabled) {
				this.setStatus('disabled');
				return;
			}
			const state = this.view.state;
			const cursor = state.selection.main.head;
			if (!state.selection.main.empty) {
				this.pendingDocumentText = null;
				this.setStatus('enabled');
				return;
			}
			if (this.view.composing) {
				this.waitingForCompositionEnd = true;
				this.setStatus('waiting');
				return;
			}
			const docText = state.doc.toString();
			if (this.pendingDocumentText !== null && docText === this.pendingDocumentText) {
				this.pendingDocumentText = null;
				this.setStatus('enabled');
				return;
			}
			this.pendingDocumentText = null;
			const prefix = state.doc.sliceString(0, cursor).slice(-MAX_AUTOCOMPLETE_MESSAGE_CHARS);
			const suffix = state.doc.sliceString(cursor, cursor + MAX_AUTOCOMPLETE_SUFFIX_CHARS);
			if (prefix.trim().length < 8) {
				this.setStatus('enabled');
				return;
			}
			this.setStatus('requesting');
			const version = this.requestVersion;
			const requestId = createAutocompleteRequestId();
			this.activeRequestId = requestId;
			const prefixStart = cursor - prefix.length;
			const contextStart = prefixStart + getAutocompleteContextStart(prefix, options.contextChars);
			const contextRanges = [{ from: contextStart, to: cursor }];
			if (suffix.trim()) contextRanges.push({ from: cursor, to: cursor + suffix.length });
			this.view.dispatch({ effects: setAutocompleteContext.of(contextRanges) });
			let noteId: string | undefined;
			try {
				const facet = editorControl?.joplinExtensions?.noteIdFacet;
				if (facet) noteId = state.facet(facet);
			} catch { /* Older Joplin versions may not expose the note ID facet. */ }

			try {
				const result = await context.postMessage({ type: 'jarvis.inlineAutocomplete', prefix, suffix, noteId, requestId, contextChars: options.contextChars });
				if (this.activeRequestId === requestId) this.activeRequestId = null;
				if (this.destroyed || version !== this.requestVersion) return;
				this.clearRequestContext();
				if (!result?.text) {
					this.setStatus('enabled');
					return;
				}
				const current = this.view.state;
				if (current.doc.toString() !== docText || current.selection.main.head !== cursor || !current.selection.main.empty) {
					this.setStatus('enabled');
					return;
				}
				this.view.dispatch({ effects: setInlineSuggestion.of({ from: cursor, text: result.text }) });
				this.setStatus('ready');
			} catch (error) {
				if (this.activeRequestId === requestId) this.activeRequestId = null;
				if (this.destroyed || version !== this.requestVersion) return;
				this.clearRequestContext();
				this.setStatus('enabled');
				console.debug('Jarvis: inline autocomplete request failed', error);
			} finally {
				if (this.activeRequestId === requestId) this.activeRequestId = null;
			}
		}

		accept(): boolean {
			const suggestion = this.view.state.field(inlineSuggestionField, false);
			if (!suggestion) return false;
			this.suppressNextChange = true;
			this.pendingDocumentText = null;
			this.view.dispatch({
				changes: { from: suggestion.from, insert: suggestion.text },
				selection: { anchor: suggestion.from + suggestion.text.length },
				effects: setInlineSuggestion.of(null),
			});
			this.view.focus();
			return true;
		}

		destroy() {
			this.destroyed = true;
			this.cancelPending();
			this.view.dom.removeEventListener('compositionend', this.compositionEndHandler);
			this.status.remove();
		}
	});
}

// modified from: https://github.com/personalizedrefrigerator/bug-report/tree/example/plugin-scroll-to-line
export default (context: ContentScriptContext): MarkdownEditorContentScriptModule => {
	return {
		plugin: (editorControl: any) => {
			if (!editorControl.cm6) { return; }
			const options = { enabled: true, contextChars: 6000 };
			const autocompletePlugin = createInlineAutocompletePlugin(context, editorControl, options);
			editorControl.addExtension([
				inlineSuggestionField,
				autocompleteContextField,
				autocompletePlugin,
				Prec.highest(keymap.of([{
					key: 'Tab',
					run(view) {
						const plugin = view.plugin(autocompletePlugin);
						return plugin ? plugin.accept() : false;
					},
				}])),
			]);

      // Running in CM6
      editorControl.registerCommand('scrollToJarvisLine', (lineNumber: number) => {
        const editor: EditorView = editorControl.editor;

        // Bounds checking
        if (lineNumber < 0) {
            lineNumber = 0;
        }
        if (lineNumber > editor.state.doc.lines) {
            lineNumber = editor.state.doc.lines;
        }

        // Scroll to line, place the line at the *top* of the editor
        const lineInfo = editor.state.doc.line(lineNumber + 1);
        editor.dispatch(editor.state.update({
            selection: { anchor: lineInfo.from },
            effects: EditorView.scrollIntoView(lineInfo.from, {y: 'start'})
        }));

        editor.focus();
      });

      editorControl.registerCommand('jarvis.replaceSelectionAround', (text: string) => {
        const editor: EditorView = editorControl.editor;
        const state = editor.state;
        const ranges = state.selection.ranges;

        if (!ranges.length) {
          return;
        }

        const insertText = typeof text === 'string' ? text : String(text ?? '');

        const changes = ranges.map(range => ({
          from: range.from,
          to: range.to,
          insert: insertText,
        }));

        const selection = EditorSelection.create(
          ranges.map(range => EditorSelection.range(range.from, range.from + insertText.length))
        );

        editor.dispatch({
          changes,
          selection,
          scrollIntoView: true,
        });

        editor.focus();
      });
		},
	};
};
