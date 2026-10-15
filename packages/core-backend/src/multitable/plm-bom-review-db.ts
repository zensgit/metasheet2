export type PlmQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount: number }>
export interface PlmPool {
  transaction<T>(fn: (tx: { query: PlmQuery }) => Promise<T>): Promise<T>
}
