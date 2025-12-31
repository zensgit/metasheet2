
import { ICollectionManager } from '../di/identifiers';
import { ViewFilter } from '../libs/view-engine/filter';
import { ViewSort } from '../libs/view-engine/sort';
import { IFilterInfo, ISortInfo, IField } from '../libs/fields/types';

export class ViewService {
  static inject = [ICollectionManager];

  constructor(
    private collections: ICollectionManager
  ) {}

  /**
   * Fetches data for a view, applying filter and sort logic.
   * 
   * @param spreadsheetId 
   * @param options 
   */
  public async getViewData(
    spreadsheetId: string, 
    options: { filter?: IFilterInfo; sort?: ISortInfo }
  ): Promise<{ rows: any[]; total: number }> {
    const definition = await this.collections.getDefinition(spreadsheetId);
    if (!definition) {
        throw new Error(`Spreadsheet ${spreadsheetId} not found`);
    }

    const repository = this.collections.getRepository(spreadsheetId);
    
    // 1. Fetch all data (In a real DB, we might push some filters down to SQL)
    // For now, we fetch all and filter in memory using our ported logic.
    const allRows = await repository.find();

    // 2. Build Field Map for Engine
    const fieldMap = new Map<string, IField>();
    definition.fields.forEach(f => {
        fieldMap.set(f.name, {
            id: f.name,
            name: f.title || f.name,
            type: f.type,
            property: f.options ? { options: f.options } : {}
        });
    });

    // 3. Apply Filter
    const filterEngine = new ViewFilter(fieldMap);
    let resultRows = filterEngine.apply(allRows, options.filter);

    // 4. Apply Sort
    const sortEngine = new ViewSort(fieldMap);
    resultRows = sortEngine.apply(resultRows, options.sort);

    return {
        rows: resultRows,
        total: resultRows.length
    };
  }
}
