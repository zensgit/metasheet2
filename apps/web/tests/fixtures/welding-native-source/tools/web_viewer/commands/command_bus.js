function makeResult(ok, changed, extras = {}) {
  return {
    ok,
    changed,
    message: '',
    error_code: '',
    ...extras,
  };
}

export class CommandBus extends EventTarget {
  constructor(context) {
    super();
    this.context = context;
    this.registry = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 200;
  }

  register(command) {
    if (!command || typeof command.id !== 'string') {
      throw new Error('Invalid command registration.');
    }
    this.registry.set(command.id, command);
  }

  listCommands() {
    return [...this.registry.values()].map((command) => ({ id: command.id, label: command.label }));
  }

  canExecute(id, payload = {}) {
    const command = this.registry.get(id);
    if (!command) return false;
    if (typeof command.canExecute !== 'function') return true;
    return command.canExecute(this.context, payload) === true;
  }

  execute(id, payload = {}) {
    const command = this.registry.get(id);
    if (!command) {
      const result = makeResult(false, false, {
        message: `Command not found: ${id}`,
        error_code: 'COMMAND_NOT_FOUND',
      });
      this.emitExecution(id, payload, result);
      return result;
    }
    if (typeof command.canExecute === 'function' && command.canExecute(this.context, payload) !== true) {
      const result = makeResult(false, false, {
        message: `Command cannot execute: ${id}`,
        error_code: 'CANNOT_EXECUTE',
      });
      this.emitExecution(id, payload, result);
      return result;
    }

    let result;
    try {
      result = command.execute(this.context, payload);
    } catch (error) {
      result = makeResult(false, false, {
        message: error?.message || String(error),
        error_code: 'COMMAND_EXCEPTION',
      });
    }

    if (!result || typeof result !== 'object') {
      result = makeResult(false, false, {
        message: `Command returned invalid result: ${id}`,
        error_code: 'INVALID_RESULT',
      });
    }

    if (result.ok && result.changed && typeof result.undo === 'function' && typeof result.redo === 'function') {
      this.pushHistory({
        id,
        label: command.label || id,
        undo: result.undo,
        redo: result.redo,
      });
    }

    this.emitExecution(id, payload, result);
    return result;
  }

  pushHistory(entry) {
    this.undoStack.push(entry);
    this.redoStack = [];
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.emitHistory();
  }

  undo() {
    if (this.undoStack.length === 0) {
      return makeResult(false, false, {
        message: 'Nothing to undo',
        error_code: 'UNDO_EMPTY',
      });
    }
    const entry = this.undoStack.pop();
    try {
      entry.undo();
      this.redoStack.push(entry);
      this.emitHistory();
      return makeResult(true, true, { message: `Undo ${entry.label}` });
    } catch (error) {
      this.undoStack.push(entry);
      return makeResult(false, false, {
        message: error?.message || String(error),
        error_code: 'UNDO_FAILED',
      });
    }
  }

  redo() {
    if (this.redoStack.length === 0) {
      return makeResult(false, false, {
        message: 'Nothing to redo',
        error_code: 'REDO_EMPTY',
      });
    }
    const entry = this.redoStack.pop();
    try {
      entry.redo();
      this.undoStack.push(entry);
      this.emitHistory();
      return makeResult(true, true, { message: `Redo ${entry.label}` });
    } catch (error) {
      this.redoStack.push(entry);
      return makeResult(false, false, {
        message: error?.message || String(error),
        error_code: 'REDO_FAILED',
      });
    }
  }

  emitExecution(id, payload, result) {
    this.dispatchEvent(
      new CustomEvent('executed', {
        detail: {
          id,
          payload,
          result,
        },
      }),
    );
  }

  emitHistory() {
    this.dispatchEvent(
      new CustomEvent('history', {
        detail: {
          undoDepth: this.undoStack.length,
          redoDepth: this.redoStack.length,
        },
      }),
    );
  }
}

export function commandResult(ok, changed, extras = {}) {
  return makeResult(ok, changed, extras);
}
