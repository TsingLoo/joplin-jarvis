/**
 * Tag lookup and creation, shared by the note DB catalog and the exclusion
 * commands.
 *
 * Joplin's API creates a tag on first use, so a plugin that writes a tag by
 * title needs the ID to exist first. Tag IDs are looked up once per session:
 * a tag cannot disappear while the plugin that relies on it is running.
 */
import joplin from 'api';
import { getLogger } from '../utils/logger';

const log = getLogger();

interface TagCacheEntry {
  id: string | null;
  inflight: Promise<string> | null;
}

const tag_cache = new Map<string, TagCacheEntry>();

/**
 * Resolve a tag title to its ID, creating the tag when it does not exist yet.
 * Concurrent callers for the same title share one request.
 */
export async function ensure_tag_id(tag_title: string): Promise<string> {
  let cache_entry = tag_cache.get(tag_title);
  if (!cache_entry) {
    cache_entry = { id: null, inflight: null };
    tag_cache.set(tag_title, cache_entry);
  }
  const entry = cache_entry;
  if (entry.id) {
    return entry.id;
  }
  if (entry.inflight) {
    return entry.inflight;
  }
  entry.inflight = (async () => {
    try {
      const tag_search = await joplin.data.get(['tags'], { query: tag_title, fields: ['id', 'title'] });
      const existing = tag_search.items?.find((t: any) => t.title === tag_title);
      if (existing?.id) {
        entry.id = existing.id;
        return existing.id;
      }
    } catch (error) {
      log.warn('Failed to query tag', { tag: tag_title, error });
    }
    try {
      const created = await joplin.data.post(['tags'], null, { title: tag_title });
      entry.id = created.id;
      return created.id;
    } catch (error) {
      log.warn('Failed to create tag; retrying lookup', { tag: tag_title, error });
      const verify_search = await joplin.data.get(['tags'], { query: tag_title, fields: ['id', 'title'] });
      const fallback = verify_search.items?.find((t: any) => t.title === tag_title)?.id;
      if (fallback) {
        entry.id = fallback;
        return fallback;
      }
      throw error;
    }
  })();
  try {
    const id = await entry.inflight;
    entry.inflight = null;
    return id;
  } catch (error) {
    entry.inflight = null;
    throw error;
  }
}
