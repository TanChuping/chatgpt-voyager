import { hashString } from '@/core/utils/hash';
import type { Folder, FolderData } from '@/pages/content/folder/types';

import { type ImportCounts, type LocalSections, ROOT_FOLDER, canonicalJson } from './model';

function mergeRows<T>(
  local: T[],
  incoming: T[],
  counts: ImportCounts,
  identity: (item: T) => string,
  withNewId?: (item: T, id: string) => T,
  same?: (a: T, b: T) => boolean,
): T[] {
  const merged = [...local];
  const identities = new Map(local.map((item) => [identity(item), item]));
  const exact = new Set(local.map(canonicalJson));
  for (const item of incoming) {
    const id = identity(item);
    const serialized = canonicalJson(item);
    const match = identities.get(id);
    if (exact.has(serialized) || (match !== undefined && same?.(match, item))) {
      counts.duplicates++;
      continue;
    }
    if (!identities.has(id)) {
      counts.added++;
      merged.push(item);
      identities.set(id, item);
      exact.add(serialized);
      continue;
    }
    // A favorite has an actual turn ID. Changing it would break navigation.
    if (!withNewId) {
      counts.conflicts++;
      continue;
    }
    const alternate = findAlternateId(
      id,
      serialized,
      identities,
      (candidate) =>
        canonicalJson(candidate) === canonicalJson(withNewId(item, identity(candidate))),
    );
    if (identities.has(alternate)) {
      counts.duplicates++;
    } else {
      counts.conflicts++;
      const copy = withNewId(item, alternate);
      merged.push(copy);
      identities.set(alternate, copy);
      exact.add(canonicalJson(copy));
    }
  }
  return merged;
}

function findAlternateId<T>(
  originalId: string,
  serialized: string,
  ids: Map<string, T>,
  same: (existing: T) => boolean,
): string {
  const base = `${originalId}~import-${hashString(serialized)}`;
  let id = base;
  for (let suffix = 2; ids.has(id); suffix++) {
    const candidate = ids.get(id);
    if (candidate !== undefined && same(candidate)) break;
    id = `${base}-${suffix}`;
  }
  return id;
}

function mergeRecordRows<T>(
  local: Record<string, T[]>,
  incoming: Record<string, T[]>,
  counts: ImportCounts,
  identity: (item: T) => string,
  withNewId?: (item: T, id: string) => T,
): Record<string, T[]> {
  const merged = { ...local };
  for (const [key, rows] of Object.entries(incoming)) {
    if (!rows.length) continue;
    merged[key] = mergeRows(merged[key] ?? [], rows, counts, identity, withNewId);
  }
  return merged;
}

const byId = <T extends { id: string }>(item: T) => item.id;
const withId = <T extends { id: string }>(item: T, id: string): T => ({ ...item, id });
type FolderReference = FolderData['folderContents'][string][number];
const refId = (item: FolderReference) => item.conversationId;

function folderFields(folder: Folder) {
  const { isExpanded, createdAt, updatedAt, sortIndex, ...fields } = folder;
  return { ...fields, parentId: fields.parentId ?? null };
}

function referenceFields(ref: FolderReference) {
  const { addedAt, lastOpenedAt, updatedAt, sortIndex, ...fields } = ref;
  return fields;
}

function sameSortOrder(a: { sortIndex?: number }, b: { sortIndex?: number }): boolean {
  // The manager fills in missing indexes when reading legacy records.
  return a.sortIndex === undefined || b.sortIndex === undefined || a.sortIndex === b.sortIndex;
}

function sameFolderFields(a: Folder, b: Folder): boolean {
  return sameSortOrder(a, b) && canonicalJson(folderFields(a)) === canonicalJson(folderFields(b));
}

function sameReference(a: FolderReference, b: FolderReference): boolean {
  return (
    sameSortOrder(a, b) && canonicalJson(referenceFields(a)) === canonicalJson(referenceFields(b))
  );
}

function mergeFolders(local: FolderData, incoming: FolderData, counts: ImportCounts): FolderData {
  const folders = [...local.folders];
  const folderContents = { ...local.folderContents };
  const ids = new Map(local.folders.map((row) => [row.id, row]));
  const incomingIds = new Map(incoming.folders.map((row) => [row.id, row]));
  const remappedIds = new Map<string, string>();
  const appendFolder = (folder: Folder) => {
    folders.push(folder);
    ids.set(folder.id, folder);
  };

  for (const folder of incoming.folders) {
    const unresolved: Folder[] = [];
    let parent: Folder | undefined = folder;
    while (parent && !remappedIds.has(parent.id)) {
      unresolved.push(parent);
      parent = parent.parentId ? incomingIds.get(parent.parentId) : undefined;
    }
    for (const original of unresolved.reverse()) {
      const parentId = original.parentId;
      const row = parentId ? { ...original, parentId: remappedIds.get(parentId)! } : original;
      const members = incoming.folderContents[row.id] ?? [];
      const existing = ids.get(row.id);
      const sameFolder = existing && sameFolderFields(existing, row);
      const existingRefs = new Map((folderContents[row.id] ?? []).map((ref) => [refId(ref), ref]));
      const conflictingRefs =
        sameFolder &&
        members.some((ref) => {
          const match = existingRefs.get(refId(ref));
          return match && !sameReference(match, ref);
        });
      let id = row.id;
      if (existing && (!sameFolder || conflictingRefs)) {
        // FolderManager allows one reference per conversation in a folder.
        // Preserve a distinct membership in a copy instead of inventing a
        // conversation ID that would break its attachment to the real chat.
        const fields = { ...folderFields(row), sortIndex: row.sortIndex };
        const signature = canonicalJson(
          conflictingRefs
            ? {
                fields,
                members: members.map((ref) => ({
                  ...referenceFields(ref),
                  sortIndex: ref.sortIndex,
                })),
              }
            : fields,
        );
        id = findAlternateId(row.id, signature, ids, (candidate) => {
          if (!sameFolderFields(candidate, withId(row, candidate.id))) return false;
          const candidateRefs = new Map(
            (folderContents[candidate.id] ?? []).map((ref) => [refId(ref), ref]),
          );
          return members.every((ref) => {
            const match = candidateRefs.get(refId(ref));
            return !match || sameReference(match, ref);
          });
        });
        if (ids.has(id)) counts.duplicates++;
        else {
          counts.conflicts++;
          appendFolder(withId(row, id));
        }
      } else if (existing) {
        counts.duplicates++;
      } else {
        counts.added++;
        appendFolder(row);
      }
      remappedIds.set(row.id, id);
      if (members.length) {
        if (conflictingRefs && id !== row.id) {
          const alternateRefs = new Map((folderContents[id] ?? []).map((ref) => [refId(ref), ref]));
          for (const ref of members) {
            const originalRef = existingRefs.get(refId(ref));
            const alternateRef = alternateRefs.get(refId(ref));
            if (alternateRef && sameReference(alternateRef, ref)) {
              counts.duplicates++;
            } else if (originalRef && !sameReference(originalRef, ref)) {
              // The differing association is represented by the folder copy.
              counts.conflicts++;
            } else {
              counts.added++;
            }
          }
          folderContents[id] = mergeRows(
            folderContents[id] ?? [],
            members,
            emptyCounts(0, 0),
            refId,
            undefined,
            sameReference,
          );
        } else {
          folderContents[id] = mergeRows(
            folderContents[id] ?? [],
            members,
            counts,
            refId,
            undefined,
            sameReference,
          );
        }
      }
    }
  }

  const rootMembers = incoming.folderContents[ROOT_FOLDER] ?? [];
  if (rootMembers.length) {
    const existingRefs = new Map(
      (folderContents[ROOT_FOLDER] ?? []).map((ref) => [refId(ref), ref]),
    );
    const ordinary: FolderReference[] = [];
    for (const ref of rootMembers) {
      const match = existingRefs.get(refId(ref));
      if (!match || sameReference(match, ref)) {
        ordinary.push(ref);
        continue;
      }
      // The root bucket cannot be copied. Use a regular folder for alternate
      // root references so they can still be opened and managed normally.
      const alternate = findAlternateId(
        'imported-root',
        canonicalJson({ ...referenceFields(ref), sortIndex: ref.sortIndex }),
        ids,
        (candidate) =>
          (folderContents[candidate.id] ?? []).some((item) => sameReference(item, ref)),
      );
      if (ids.has(alternate)) {
        counts.duplicates++;
      } else {
        counts.conflicts++;
        appendFolder({
          id: alternate,
          name: ref.title || 'Imported',
          parentId: null,
          isExpanded: true,
          createdAt: ref.addedAt ?? 0,
          updatedAt: ref.updatedAt ?? ref.addedAt ?? 0,
        });
        folderContents[alternate] = [ref];
      }
    }
    if (ordinary.length) {
      folderContents[ROOT_FOLDER] = mergeRows(
        folderContents[ROOT_FOLDER] ?? [],
        ordinary,
        counts,
        refId,
        undefined,
        sameReference,
      );
    }
  }
  return { ...local, folders, folderContents };
}

function countRecordRows(value: Record<string, unknown[]>): number {
  return Object.values(value).reduce((total, rows) => total + rows.length, 0);
}

function emptyCounts(local: number, incoming: number): ImportCounts {
  return { local, incoming, duplicates: 0, conflicts: 0, added: 0 };
}

export function mergeLocalSections(local: LocalSections, incoming: Partial<LocalSections>) {
  const merged: LocalSections = { ...local };
  const sections: Partial<Record<keyof LocalSections, ImportCounts>> = {};
  if (incoming.folders) {
    const size = (value: FolderData) =>
      value.folders.length + countRecordRows(value.folderContents);
    const counts = emptyCounts(size(local.folders), size(incoming.folders));
    merged.folders = mergeFolders(local.folders, incoming.folders, counts);
    sections.folders = counts;
  }
  if (incoming.favorites) {
    const size = (value: LocalSections['favorites']) =>
      countRecordRows(value.shared.messages) + countRecordRows(value.legacy);
    const counts = emptyCounts(size(local.favorites), size(incoming.favorites));
    merged.favorites = {
      shared: {
        ...local.favorites.shared,
        messages: mergeRecordRows(
          local.favorites.shared.messages,
          incoming.favorites.shared.messages,
          counts,
          (item) => item.turnId,
        ),
      },
      legacy: mergeRecordRows(
        local.favorites.legacy,
        incoming.favorites.legacy,
        counts,
        (id) => id,
      ),
    };
    sections.favorites = counts;
  }
  if (incoming.textPins) {
    const counts = emptyCounts(countRecordRows(local.textPins), countRecordRows(incoming.textPins));
    merged.textPins = mergeRecordRows(local.textPins, incoming.textPins, counts, byId, withId);
    sections.textPins = counts;
  }
  if (incoming.highlights) {
    const counts = emptyCounts(
      countRecordRows(local.highlights),
      countRecordRows(incoming.highlights),
    );
    merged.highlights = mergeRecordRows(
      local.highlights,
      incoming.highlights,
      counts,
      byId,
      withId,
    );
    sections.highlights = counts;
  }
  if (incoming.prompts) {
    const counts = emptyCounts(local.prompts.length, incoming.prompts.length);
    merged.prompts = mergeRows(local.prompts, incoming.prompts, counts, byId, withId);
    sections.prompts = counts;
  }
  return { merged, sections };
}
