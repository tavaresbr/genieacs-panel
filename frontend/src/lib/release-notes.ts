/**
 * The order the "what's new" modal shows a release in.
 *
 * `release.json` lists commits in the order they were made, and most of them
 * are maintenance: v1.19.0 carried 243 maintenance entries against 29 new
 * features, so the features sat scattered through a list nobody scrolls to the
 * end of. Grouped by what a change means to the person reading — the same
 * order the CHANGELOG uses — what is new comes first.
 */
export const CATEGORY_ORDER = ['Breaking', 'New', 'Improved', 'Fixed', 'Changed', 'Security', 'Maintenance'] as const

/**
 * Sorts by category, keeping the original order inside each one. A category
 * this file does not know goes last rather than first: the generator may grow
 * one before this list does, and an unrecognised label is not a headline.
 */
export function orderReleaseChanges<T extends { category: string }>(changes: readonly T[]): T[] {
  const rank = (category: string) => {
    const index = (CATEGORY_ORDER as readonly string[]).indexOf(category)
    return index === -1 ? CATEGORY_ORDER.length : index
  }
  return changes
    .map((change, position) => ({ change, position }))
    .sort((a, b) => rank(a.change.category) - rank(b.change.category) || a.position - b.position)
    .map(({ change }) => change)
}
