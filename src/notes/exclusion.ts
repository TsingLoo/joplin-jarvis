/**
 * Note-level privacy control.
 *
 * "Never indexed" and "never sent" are one setting with two effects, so the
 * commands that toggle a note and the code that checks one live together here.
 * The tag is the source of truth for notes because it syncs with the note, and
 * the plugin cannot rely on any per-device setting for that.
 */
import joplin from 'api';
import { clearObjectReferences } from '../utils';
import { get_note_exclusion, EXCLUSION_TAGS, type ExclusionReason } from './noteHelpers';
import { ensure_tag_id } from './tags';
import { getLogger } from '../utils/logger';
import type { JarvisSettings } from '../ux/settings';

const log = getLogger();

export { EXCLUSION_TAGS };

/** The tag written by this plugin's own exclude command. */
export const JARVIS_EXCLUDE_TAG = 'jarvis-exclude';

/** Note or notebook title, and that of the containing notebook when known. */
export interface ExcludedTarget {
  kind: 'note' | 'notebook';
  title: string;
  parent_title?: string;
}

export interface ExclusionStatus {
  excluded: boolean;
  reason?: ExclusionReason;
  /** Exclusion tags currently carried by the note. */
  tags: string[];
}

/**
 * How long a cached status may be believed. Exclusion is switched by this
 * plugin's own commands (which invalidate) or by editing tags in Joplin's UI
 * (which the note-change listener invalidates), so this only bounds the window
 * in which a tag added from another device may go unnoticed.
 */
const STATUS_TTL_MS = 30_000;

let cachedStatus: { note_id: string; at: number; status: ExclusionStatus } | null = null;

/** Forget the cached status, e.g. after an exclusion command or a note change. */
export function clear_exclusion_status_cache(): void {
  cachedStatus = null;
}

/**
 * `get_note_exclusion_status` with a short-lived per-note cache.
 *
 * Inline autocomplete asks on every pause in typing, so the uncached version
 * would cost an API call per suggestion for an answer that only changes when
 * the user does something explicit.
 */
export async function get_cached_exclusion_status(
  note: { id: string; parent_id?: string; is_conflict?: boolean; deleted_time?: number },
  settings: JarvisSettings,
): Promise<ExclusionStatus> {
  const now = Date.now();
  if (cachedStatus && cachedStatus.note_id === note.id && (now - cachedStatus.at) < STATUS_TTL_MS) {
    return cachedStatus.status;
  }
  const status = await get_note_exclusion_status(note, settings);
  cachedStatus = { note_id: note.id, at: now, status };
  return status;
}

/**
 * Fetch the note's tags once and decide both kinds of exclusion from them and
 * from the note's notebook, including notebooks nested inside an excluded one.
 */
export async function get_note_exclusion_status(
  note: { id: string; parent_id?: string; is_conflict?: boolean; deleted_time?: number },
  settings: JarvisSettings,
): Promise<ExclusionStatus> {
  let tags: string[] = [];
  let response: any = null;
  try {
    response = await joplin.data.get(['notes', note.id, 'tags'], { fields: ['title'], limit: 100 });
    tags = (response?.items ?? [])
      .map((t: any) => (typeof t?.title === 'string' ? t.title : null))
      .filter((t: string | null): t is string => !!t);
  } catch (error) {
    log.debug(`Failed to read tags for note ${note.id}`, error);
  } finally {
    clearObjectReferences(response);
  }

  const result = await get_note_exclusion(note, tags, settings, {
    // Deleted and conflict notes are refused too, so they have to be reported
    // as such rather than as a plain exclusion
    checkDeleted: true,
    checkTags: true,
  });

  return { excluded: result.excluded, reason: result.reason, tags };
}

/**
 * Tag or untag a note as excluded, keeping its other tags.
 * Returns false when nothing had to change.
 */
async function set_excluded_tag(note_id: string, exclude: boolean): Promise<boolean> {
  let response: any = null;
  let tags: string[] = [];
  try {
    response = await joplin.data.get(['notes', note_id, 'tags'], { fields: ['title'], limit: 100 });
    tags = (response?.items ?? [])
      .map((t: any) => (typeof t?.title === 'string' ? t.title : null))
      .filter((t: string | null): t is string => !!t);
  } catch (error) {
    log.warn(`Failed to read tags for note ${note_id}`, error);
  } finally {
    clearObjectReferences(response);
  }

  const without_exclusion = tags.filter(tag => !EXCLUSION_TAGS.includes(tag));
  const next = exclude
    ? [...without_exclusion, JARVIS_EXCLUDE_TAG]
    : without_exclusion;

  const changed = next.length !== tags.length || tags.some(tag => !next.includes(tag));
  if (!changed) {
    return false;
  }

  if (exclude) {
    // The tag has to exist before it can be attached by title
    await ensure_tag_id(JARVIS_EXCLUDE_TAG);
  }
  await joplin.data.put(['notes', note_id], null, { tags: next.join(', ') });
  return true;
}

/** Exclude a note from Jarvis: no indexing, no retrieval, no model call. */
export async function exclude_note(note_id: string): Promise<boolean> {
  return set_excluded_tag(note_id, true);
}

/** Allow a note to be used by Jarvis again. */
export async function include_note(note_id: string): Promise<boolean> {
  return set_excluded_tag(note_id, false);
}

/**
 * Tell the user why an excluded note is unavailable, and how to undo it.
 * A notebook exclusion is undone from the notebook, not from the note, so the
 * message names the notebook when the ancestry is what excluded the note.
 */
export async function show_excluded_notice(target: ExcludedTarget, status: ExclusionStatus): Promise<void> {
  const what = target.kind === 'notebook' ? 'notebook' : 'note';
  const where = target.parent_title ? ` in the notebook "${target.parent_title}"` : '';

  let message: string;
  if (status.reason === 'tag') {
    const tag = status.tags.find(t => EXCLUSION_TAGS.includes(t));
    message = `Jarvis: "${target.title}" is excluded from Jarvis by the tag ${tag}, ` +
      `so it was not sent to any model. Remove that tag, or run "Include note in Jarvis" to remove it.`;
  } else if (status.reason === 'folder') {
    message = `Jarvis: "${target.title}"${where} is excluded from Jarvis, ` +
      `so it was not sent to any model. Run "Include notebook in Jarvis" on that notebook to use it here.`;
  } else if (status.reason === 'conflict') {
    message = `Jarvis: "${target.title}" is a conflict note. Jarvis never reads or writes conflict notes.`;
  } else if (status.reason === 'deleted') {
    message = `Jarvis: "${target.title}" is in the trash. Restore it before using Jarvis on it.`;
  } else {
    message = `Jarvis: "${target.title}" is excluded from Jarvis (${what}), so it was not sent to any model.`;
  }

  await joplin.views.dialogs.showMessageBox(message);
}

/** Confirmation text after an exclusion command. */
export function exclusion_confirmation(
  target: ExcludedTarget,
  state: 'excluded' | 'included' | 'unchanged-excluded' | 'unchanged-included',
): string {
  const label = `"${target.title}"`;

  if (state === 'unchanged-excluded' || state === 'unchanged-included') {
    return state === 'unchanged-excluded'
      ? `Jarvis: ${label} was already excluded.`
      : `Jarvis: ${label} was already included.`;
  }

  const excluded = state === 'excluded';
  if (target.kind === 'notebook') {
    return excluded
      ? `Jarvis: ${label} and every notebook inside it are now excluded - their notes are not indexed, searched or sent to a model.`
      : `Jarvis: ${label} and every notebook inside it are included in Jarvis again. Re-run "Update Jarvis note DB" to index them.`;
  }
  return excluded
    ? `Jarvis: ${label} is now excluded - it is not indexed, searched or sent to a model.`
    : `Jarvis: ${label} is included in Jarvis again. Re-run "Update Jarvis note DB" to index it.`;
}
