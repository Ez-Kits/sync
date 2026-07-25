/**
 * Derive a collection name from a Firebase path (last non-empty segment).
 * e.g. `/todos` → `todos`, `users/123/todos` → `todos`
 */
export function collectionNameFromPath(collectionPath: string): string {
  const segments = collectionPath.split("/").filter(Boolean);
  const last = segments.at(-1);
  if (!last) {
    throw new Error(
      `Unable to derive collectionName from collectionPath "${collectionPath}". Pass collectionName explicitly.`,
    );
  }
  return last;
}
