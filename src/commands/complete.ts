import joplin from 'api';
import { get_chat_prompt, replace_selection } from './chat';
import { TextGenerationModel } from '../models/models';
import { JarvisSettings } from '../ux/settings';
import { clearObjectReferences } from '../utils';

const defaultAutocompleteTemplate = `Continue the following Markdown note with a useful continuation. Write valid Markdown and follow the formatting and structure already present near the cursor. Use the text after the cursor only as continuity context: connect naturally to it and do not repeat it. Use explanations, headings, lists, tables, blockquotes, links, inline code, or fenced code blocks when they fit the note. Return only note content to insert at the cursor; do not add a conversational preamble such as "Here is the continuation."\n\n{context}\n\n{placeholder}`;
const MAX_AUTOCOMPLETE_CONTEXT_CHARS = 20000;
const MAX_AUTOCOMPLETE_SUFFIX_CHARS = 500;

function prepare_inline_context(textBeforeCursor: string, maxChars: number): string {
  const limit = Math.max(500, Math.min(MAX_AUTOCOMPLETE_CONTEXT_CHARS, Math.floor(maxChars) || 6000));
  const start = Math.max(0, textBeforeCursor.length - limit);
  const context = textBeforeCursor.slice(start);
  const headingPattern = /(^|\n)[ \t]{0,3}#{1,2}(?!#)(?:[ \t]+[^\r\n]*)?[ \t\r]*$/gm;
  let lastHeadingStart = -1;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(context)) !== null) {
    const lineStart = match.index + (match[1] ? 1 : 0);
    // The bounded slice may start halfway through a line; don't treat that as a heading.
    if (lineStart === 0 && start > 0) continue;
    lastHeadingStart = lineStart;
  }
  return lastHeadingStart >= 0 ? context.slice(lastHeadingStart) : context;
}

/** Generate the inline continuation requested by a CodeMirror content script. */
export async function generate_inline_completion(
  model_gen: TextGenerationModel,
  settings: JarvisSettings,
  prefix: string,
  suffix: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  if (!settings.autocomplete_enabled || model_gen.model === null || !prefix.trim()) { return ''; }

  const note = await joplin.workspace.selectedNote();
  if (!note) { return ''; }

  try {
    const noteContext = prepare_inline_context(prefix, settings.autocomplete_context_chars);
    const boundedSuffix = suffix.slice(0, MAX_AUTOCOMPLETE_SUFFIX_CHARS);
    const followingContext = boundedSuffix.trim()
      ? `\n\nText after the cursor (for continuity only; do not repeat):\n${boundedSuffix}`
      : '';
    const context = `Note title: ${note.title}\n\nText before the cursor:\n${noteContext}${followingContext}`;
    const placeholder = 'Continue directly from the cursor, flowing naturally into any following text. Return only the continuation.';
    const template = (settings.annotate_autocomplete_prompt || '').trim() || defaultAutocompleteTemplate;
    const prompt = template
      .replace(/{context}/g, context)
      .replace(/{placeholder}/g, placeholder);
    // Inline suggestions run in the background; a timeout should fail this
    // suggestion quietly instead of opening the interactive retry dialog.
    return await model_gen.complete(prompt, { interactive: false, abortSignal });
  } finally {
    clearObjectReferences(note);
  }
}

export async function auto_complete(model_gen: TextGenerationModel, settings: JarvisSettings) {
  if (model_gen.model === null) { return; }

  const note = await joplin.workspace.selectedNote();
  if (!note) {
    return;
  }

  try {
    const context = `Note content\n===\n# ${note.title}\n\n${(await get_chat_prompt(model_gen))}\n`;
    const placeholder = `Note continued\n===\n`;

    const template = (settings.annotate_autocomplete_prompt || '').trim() || defaultAutocompleteTemplate;
    const prompt = template
      .replace(/{context}/g, context)
      .replace(/{placeholder}/g, placeholder);

    replace_selection('\n\nGenerating auto-completion....');
    const response = await model_gen.complete(prompt);
    replace_selection('\n' + response);
  } finally {
    clearObjectReferences(note);
  }
}
