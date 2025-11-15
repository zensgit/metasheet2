export type ViewRow = any;
export declare function getViewById(viewId: string): Promise<ViewRow | null>;
export declare function getViewConfig(viewId: string): Promise<any>;
export declare function updateViewConfig(viewId: string, config: any): Promise<any>;
export declare function queryGrid(args: {
    view: ViewRow;
    page: number;
    pageSize: number;
    filters: any;
    sorting: any;
}): Promise<{
    data: any[];
    meta: {
        total: number;
        page: number;
        pageSize: number;
        hasMore: boolean;
    };
}>;
export declare function queryKanban(args: {
    view: ViewRow;
    page: number;
    pageSize: number;
    filters: any;
}): Promise<any>;
//# sourceMappingURL=view-service.d.ts.map