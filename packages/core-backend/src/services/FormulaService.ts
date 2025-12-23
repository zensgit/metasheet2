export class FormulaService {
  calculate(_functionName: string, ..._args: unknown[]): unknown {
    return null
  }

  calculateFormula(_expression: string, _contextResolver?: (key: string) => unknown): unknown {
    return null
  }

  getAvailableFunctions(): string[] {
    return []
  }
}
