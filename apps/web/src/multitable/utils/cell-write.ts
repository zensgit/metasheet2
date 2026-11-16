/** What the grid's `patchCell` returns for a write that was never sent: a newer write of the same cell replaced it
 *  while it waited for its record's turn. That write carries the cell's newest value, and its answer is the cell's. */
export const CELL_WRITE_SUPERSEDED = 'superseded' as const
