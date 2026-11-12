/**
 * Store each friendship as one canonical, undirected pair. Sorting the IDs
 * means A inviting B and B inviting A resolve to the same database row.
 */
export function canonicalFriendPair(firstUserId: string, secondUserId: string): [string, string] | null {
  if (!firstUserId || !secondUserId || firstUserId === secondUserId) return null;
  return firstUserId.localeCompare(secondUserId) < 0
    ? [firstUserId, secondUserId]
    : [secondUserId, firstUserId];
}
