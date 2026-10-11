/**
 * Note-level utilities for retrieving note metadata and content.
 */
import joplin from 'api';
import { clearApiResponse } from '../utils';
import { UserDataEmbStore } from './userDataStore';
import { getLogger } from '../utils/logger';
import { is_folder_excluded } from './folderExclusion';
import type { JarvisSettings } from '../ux/settings';

const log = getLogger();
const ocrMergedFlag = Symbol('ocrTextMerged');

/** Tags that mark a note as excluded from Jarvis. */
export const EXCLUSION_TAGS = ['jarvis-exclude', 'exclude.from.jarvis'];

/**
 * Get tags for a note. Returns empty array on error.
 */
export async function get_note_tags(noteId: string): Promise<string[]> {
  let tagsResponse: any = null;
  try {
    tagsResponse = await joplin.data.get(['notes', noteId, 'tags'], { fields: ['title'] });
    const tags = tagsResponse.items.map((t: any) => t.title);
    clearApiResponse(tagsResponse);
    return tags;
  } catch (error) {
    clearApiResponse(tagsResponse);
    return [];
  }
}

// Caches for exclusion lookups. Both are filled lazily and dropped between
// batches by clear_excluded_note_ids_cache(), so a long sweep pays for each
// lookup once instead of once per note.
let excludedNoteIdsCache: Set<string> | null = null;
let exclusionObjectsCache: Array<{ id: string }> = [];

/**
 * Get all note IDs with exclusion tags via reverse-lookup.
 * Uses pagination to get all results. Cached per batch.
 */
export async function get_excluded_note_ids_by_tags(): Promise<Set<string>> {
  if (excludedNoteIdsCache) {
    return excludedNoteIdsCache;
  }

  const excludedIds = new Set<string>();
  if (exclusionObjectsCache.length === 0) {
    exclusionObjectsCache = await get_exclusion_objects();
  }

  for (const item of exclusionObjectsCache) {
    try {
      // Fetch all notes with this tag ID (paginated)
      let page = 1;
      while (true) {
        const notesResponse = await joplin.data.get(['tags', item.id, 'notes'], {
          fields: ['id'],
          page,
          limit: 100,
        });

        for (const note of notesResponse.items) {
          excludedIds.add(note.id);
        }

        const hasMore = notesResponse.has_more;
        clearApiResponse(notesResponse);

        if (!hasMore) break;
        page++;
      }
    } catch (error) {
      // Tag fetch failed - continue silently
    }
  }

  excludedNoteIdsCache = excludedIds;
  return excludedIds;
}

/**
 * Clear cached excluded note IDs (call between batches)
 */
export function clear_excluded_note_ids_cache(): void {
  excludedNoteIdsCache = null;
}

/**
 * Resolve the exclusion tags to their objects, searching for each tag title.
 *
 * This is the expensive part of an exclusion lookup (one search per tag), so
 * the result is cached separately from the note IDs: a search that reuses the
 * note-ID cache still reuses the tags, and every lookup after the first pays
 * only for the notes tagged with them.
 */
async function get_exclusion_objects(): Promise<Array<{ id: string }>> {
  const objects: Array<{ id: string }> = [];

  for (const tagTitle of EXCLUSION_TAGS) {
    try {
      // Search for tag by title using query parameter (same pattern as catalog.ts:571)
      const tagSearchResponse = await joplin.data.get(['tags'], {
        query: tagTitle,
        fields: ['id', 'title'],
      });

      // Find exact title match (query may return partial matches)
      const tag = tagSearchResponse.items?.find((t: any) => t.title === tagTitle);
      clearApiResponse(tagSearchResponse);

      if (tag?.id) {
        objects.push({ id: tag.id });
      }
    } catch (error) {
      // Tag doesn't exist or fetch failed - continue silently
    }
  }

  return objects;
}

/**
 * Append OCR text from note resources to note body.
 * Processes all resources attached to the note and appends their OCR text.
 * Idempotent - marks note as processed to prevent duplicate processing.
 */
export async function append_ocr_text_to_body(note: any): Promise<void> {
  if (!note || typeof note !== 'object' || note[ocrMergedFlag]) {
    return;
  }

  const body = typeof note.body === 'string' ? note.body : '';
  const noteId = typeof note.id === 'string' ? note.id : undefined;
  let ocrText = '';

  if (noteId) {
    const resources: {id: string; title: string; text: string}[] = [];
    try {
      let page = 0;
      let resourcesPage: any;
      do {
        page += 1;
        resourcesPage = await joplin.data.get(
          ['notes', noteId, 'resources'],
          { fields: ['id', 'title', 'ocr_text'], page }
        );
        const items = resourcesPage?.items ?? [];
        for (const resource of items) {
          const text = typeof resource?.ocr_text === 'string' ? resource.ocr_text.trim() : '';
          if (text) {
            resources.push({ id: resource.id, title: resource.title, text });
          }
        }
        const hasMore = resourcesPage?.has_more;
        // Clear API response before next iteration
        clearApiResponse(resourcesPage);
        if (!hasMore) break;
      } while (true);
    } catch (error) {
      log.debug(`Failed to retrieve OCR text for note ${noteId}:`, error);
    }
    // Sort by resource ID for deterministic hash across devices/sweeps
    resources.sort((a, b) => a.id.localeCompare(b.id));
    ocrText = resources.map(r => `\n\n## resource: ${r.title}\n\n${r.text}`).join('\n\n');
  }

  if (ocrText) {
    const separator = body ? (body.endsWith('\n') ? '\n' : '\n\n') : '';
    note.body = body + separator + ocrText;
  }

  note[ocrMergedFlag] = true;
}

/**
 * Check if a note should be excluded based on filtering criteria.
 * Handles undefined/null values gracefully.
 *
 * Synchronous, so that a scan over thousands of notes does not turn every
 * exclusion check into an await: the caller resolves the excluded-notebook
 * ancestry once and passes the result in `excludedFolders`.
 *
 * @param note - Note object with optional fields
 * @param noteTags - Array of tag titles for this note (can be undefined/null, treated as empty array)
 * @param settings - Jarvis settings containing excluded folders (can be undefined/partial)
 * @param options - Filtering options
 * @param options.checkDeleted - Whether to filter deleted notes (default: false)
 * @param options.checkTags - Whether to check exclusion tags (default: true)
 * @param options.excludedByTag - Pre-fetched set of note IDs carrying an exclusion tag
 * @param options.excludedFolders - Pre-resolved set of excluded folder IDs, including
 *   notebooks nested inside an excluded one; defaults to the plain setting value
 * @returns Object with { excluded: boolean, reason?: string }
 */
export type ExclusionReason = 'conflict' | 'folder' | 'tag' | 'deleted';

export interface NoteExclusionOptions {
  checkDeleted?: boolean;
  checkTags?: boolean;
  excludedByTag?: Set<string>;
  excludedFolders?: Set<string>;
}

export function should_exclude_note(
  note: { id?: string; parent_id?: string; is_conflict?: boolean; deleted_time?: number },
  noteTags?: string[] | null,
  settings?: JarvisSettings | null,
  options: NoteExclusionOptions = {}
): { excluded: boolean; reason?: ExclusionReason } {
  const {
    checkDeleted = false,
    checkTags = true,
    excludedByTag,
    excludedFolders = settings?.notes_exclude_folders,
  } = options;

  // Normalize inputs to handle undefined/null gracefully
  const tags = noteTags || [];

  // Check conflict notes (always checked)
  if (note.is_conflict) {
    return { excluded: true, reason: 'conflict' };
  }

  // Check excluded folders (always checked, if parent_id and excluded folders are available)
  if (note.parent_id && excludedFolders?.has(note.parent_id)) {
    return { excluded: true, reason: 'folder' };
  }

  // Check exclusion tags (optional, controlled by checkTags flag)
  if (checkTags) {
    // Check reverse-lookup first (if provided)
    if (excludedByTag && excludedByTag.has(note.id)) {
      return { excluded: true, reason: 'tag' };
    }

    // Fall back to checking tags array (for compatibility with other flows)
    if (tags.some(tag => EXCLUSION_TAGS.includes(tag))) {
      return { excluded: true, reason: 'tag' };
    }
  }

  // Check deleted (optional, controlled by checkDeleted flag)
  if (checkDeleted && note.deleted_time && note.deleted_time > 0) {
    return { excluded: true, reason: 'deleted' };
  }

  return { excluded: false };
}

/**
 * `should_exclude_note` with the notebook ancestry resolved for you.
 *
 * Use this when checking a handful of notes - the file being used right now -
 * where one folder lookup is cheaper than tracking the tree yourself. Scans
 * should call the synchronous version with `excludedFolders` resolved once.
 */
export async function get_note_exclusion(
  note: { id?: string; parent_id?: string; is_conflict?: boolean; deleted_time?: number },
  noteTags?: string[] | null,
  settings?: JarvisSettings | null,
  options: NoteExclusionOptions = {}
): Promise<{ excluded: boolean; reason?: ExclusionReason }> {
  const excludedFolders = options.excludedFolders ?? settings?.notes_exclude_folders;

  // Conflict, tag and deleted checks do not depend on the folder tree, so a
  // decisive answer here costs no API call at all.
  const direct = should_exclude_note(note, noteTags, settings, {
    ...options,
    excludedFolders: new Set<string>(),
  });
  if (direct.excluded) {
    return direct;
  }

  if (!note?.parent_id || !excludedFolders?.size) {
    return { excluded: false };
  }

  const excludedByAncestry = await is_folder_excluded(note.parent_id, excludedFolders);
  return excludedByAncestry ? { excluded: true, reason: 'folder' } : { excluded: false };
}
