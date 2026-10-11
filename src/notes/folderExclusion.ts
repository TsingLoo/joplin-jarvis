/**
 * Notebook (folder) exclusion.
 *
 * `notes_exclude_folders` holds folder IDs, and exclusion used to match the
 * note's immediate parent only, so a notebook created inside an excluded
 * notebook was indexed again. This module resolves the ancestry instead: a
 * note is excluded when any folder on its path up to the root is excluded,
 * which is what "this notebook is private" has to mean.
 *
 * The folder tree cannot change without Joplin creating, moving or deleting a
 * notebook (this plugin never does either), so it is cached and invalidated at
 * those boundaries rather than fetched per note; a full sweep of 10k notes would
 * otherwise make 20k API calls.
 */
import joplin from 'api';

/** folderId -> parent folder id ('root' for a top-level notebook). */
interface FolderTree {
  parents: Map<string, string>;
  children: Map<string, string[]>;
}

/** Cached folder tree; null until resolved, dropped at cache boundaries. */
let folderTreeCache: FolderTree | null = null;

/** Folder-tree fetch guard: the tree is shared, so one in-flight fetch is enough. */
let folderTreePromise: Promise<FolderTree> | null = null;

/**
 * Existing setting value for the excluded notebooks, split into IDs.
 * Exported string values may carry whitespace and the empty field left by
 * clearing the setting, hence the filter.
 */
export function parse_excluded_folders(raw: unknown): Set<string> {
  if (typeof raw !== 'string') {
    return new Set<string>();
  }
  return new Set(raw.split(',').map(folder => folder.trim()).filter(Boolean));
}

async function fetch_folder_tree(): Promise<FolderTree> {
  const parents = new Map<string, string>();
  const children = new Map<string, string[]>();

  let page = 1;
  while (true) {
    let response: any = null;
    try {
      response = await joplin.data.get(['folders'], { fields: ['id', 'parent_id'], page });
    } catch (error) {
      // Treat a failed page as the end of the tree rather than failing the
      // sweep: the explicit exclusions are still applied without ancestry.
      response = null;
    }
    const items = response?.items ?? [];
    const hasMore = response?.has_more;
    for (const folder of items) {
      if (!folder?.id) {
        continue;
      }
      const parent = folder.parent_id || 'root';
      parents.set(folder.id, parent);
      if (!children.has(parent)) {
        children.set(parent, []);
      }
      children.get(parent).push(folder.id);
    }
    if (!hasMore || items.length === 0) {
      break;
    }
    page++;
  }

  return { parents, children };
}

async function get_folder_tree(): Promise<FolderTree> {
  if (folderTreeCache) {
    return folderTreeCache;
  }
  if (!folderTreePromise) {
    folderTreePromise = fetch_folder_tree()
      .then(tree => {
        folderTreeCache = tree;
        return tree;
      })
      .finally(() => {
        folderTreePromise = null;
      });
  }
  return folderTreePromise;
}

/**
 * Drop the cached folder tree. Call after a notebook is created, renamed, moved
 * or deleted, so a notebook added inside an excluded one is seen on the next
 * check instead of after a restart.
 */
export function clear_folder_exclusion_cache(): void {
  folderTreeCache = null;
}

/** The chain of folder IDs from `folder_id` up to the root, including it. */
async function folder_ancestors(folder_id: string): Promise<string[]> {
  const tree = await get_folder_tree();
  const chain: string[] = [];
  let current: string | undefined = folder_id;
  while (current && current !== 'root') {
    chain.push(current);
    current = tree.parents.get(current);
  }
  return chain;
}

/**
 * True when `parent_id` is itself excluded or sits inside an excluded notebook.
 *
 * This walks up from one folder, so it is the right call for a single note
 * (the one being used right now). A scan over many notes resolves
 * `find_excluded_folders` once instead and tests membership.
 */
export async function is_folder_excluded(
  parent_id: string | undefined | null,
  excluded: Set<string>,
): Promise<boolean> {
  if (!parent_id || excluded.size === 0) {
    return false;
  }
  const chain = await folder_ancestors(parent_id);
  if (chain.length === 0) {
    // Not in the tree: fall back to the plain check, so a folder that no
    // longer exists keeps behaving as it did before ancestry was resolved
    return excluded.has(parent_id);
  }
  return chain.some(folder_id => excluded.has(folder_id));
}

/**
 * Every folder that `is_folder_excluded` would report as excluded: each listed
 * notebook and everything nested inside it.
 *
 * This is the set a scan of the whole library checks against, so it has to be
 * resolved by walking down from the excluded notebooks, not up from them.
 *
 * One upward walk per folder would make a sweep quadratic in the notebook
 * tree's depth, so the verdict is built in a single pass instead: a folder is
 * excluded when it is listed, or when its parent is excluded, and visiting
 * parents before children makes one pass enough.
 */
export async function find_excluded_folders(excluded: Set<string>): Promise<Set<string>> {
  const result = new Set<string>();
  if (excluded.size === 0) {
    return result;
  }

  const tree = await get_folder_tree();

  // Folders grouped by depth from the root, so every parent is decided before
  // its children are considered
  const byDepth: string[][] = [];
  const visit = (folder_id: string, depth: number): void => {
    if (!byDepth[depth]) {
      byDepth[depth] = [];
    }
    byDepth[depth].push(folder_id);
    for (const child of tree.children.get(folder_id) ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const child of tree.children.get('root') ?? []) {
    visit(child, 0);
  }

  for (const level of byDepth) {
    for (const folder_id of level) {
      const parent = tree.parents.get(folder_id);
      const parent_excluded = !!parent && result.has(parent);
      if (excluded.has(folder_id) || parent_excluded) {
        result.add(folder_id);
      }
    }
  }

  // A listed notebook that is not in the tree (deleted, or not synced yet) is
  // still excluded, matching the plain `Set.has` check this replaces.
  for (const folder_id of excluded) {
    if (!tree.parents.has(folder_id)) {
      result.add(folder_id);
    }
  }

  return result;
}

/**
 * `folder_id` and every notebook nested inside it.
 *
 * This is what the exclude command writes into the setting. The scan does not
 * depend on that list being complete - it resolves ancestry - so a notebook
 * created inside an excluded one later is still covered.
 */
export async function expand_folder_subtree(folder_id: string): Promise<string[]> {
  return [...await find_excluded_folders(new Set([folder_id]))];
}
