/** A unit-test collaborator implements only the members exercised by that case.
 * Supplied member names and signatures are checked against the real interface.
 * Keep the incomplete-object assertion at this test boundary.
 */
export function double<T extends object>(members: Partial<T>): T {
  return members as T
}
