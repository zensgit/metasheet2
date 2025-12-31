
export interface IMutationInfo {
    id: string;
    params: any;
}

export interface IUndoRedoItem {
    unitID: string;
    undoMutations: IMutationInfo[];
    redoMutations: IMutationInfo[];
    id?: string;
}

export interface IUndoRedoStatus {
    undos: number;
    redos: number;
}

const STACK_CAPACITY = 20;

export class HistoryService {
    protected readonly _undoStacks = new Map<string, IUndoRedoItem[]>();
    protected readonly _redoStacks = new Map<string, IUndoRedoItem[]>();

    constructor() {}

    pushUndoRedo(item: IUndoRedoItem): void {
        const { unitID } = item;
        const redoStack = this._getStack(unitID, this._redoStacks);
        const undoStack = this._getStack(unitID, this._undoStacks);

        // Clear redo stack on new action
        redoStack.length = 0;

        undoStack.push(item);
        if (undoStack.length > STACK_CAPACITY) {
            undoStack.splice(0, 1);
        }
    }

    undo(unitId: string): IUndoRedoItem | null {
        const undoStack = this._getStack(unitId, this._undoStacks);
        const item = undoStack.pop();
        
        if (item) {
            const redoStack = this._getStack(unitId, this._redoStacks);
            redoStack.push(item);
            return item;
        }
        return null;
    }

    redo(unitId: string): IUndoRedoItem | null {
        const redoStack = this._getStack(unitId, this._redoStacks);
        const item = redoStack.pop();

        if (item) {
            const undoStack = this._getStack(unitId, this._undoStacks);
            undoStack.push(item);
            return item;
        }
        return null;
    }

    getStatus(unitId: string): IUndoRedoStatus {
        return {
            undos: this._getStack(unitId, this._undoStacks).length,
            redos: this._getStack(unitId, this._redoStacks).length,
        };
    }

    private _getStack(unitId: string, map: Map<string, IUndoRedoItem[]>): IUndoRedoItem[] {
        let stack = map.get(unitId);
        if (!stack) {
            stack = [];
            map.set(unitId, stack);
        }
        return stack;
    }
}
