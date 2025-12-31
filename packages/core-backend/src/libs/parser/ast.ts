
import { Token, TokenType } from './token';
import { BasicValueType } from '../../libs/fields/types'; // Corrected import

export enum AstNodeType {
  BinaryOperatorNode = 'BinaryOperatorNode',
  UnaryOperatorNode = 'UnaryOperatorNode',
  ValueOperandNode = 'ValueOperandNode',
  PureValueOperandNode = 'PureValueOperandNode',
  CallOperandNode = 'CallOperandNode',
  StringOperandNode = 'StringOperandNode',
  NumberOperandNode = 'NumberOperandNode',
}

export abstract class AstNode {
  readonly token: Token;
  readonly name!: AstNodeType;
  valueType!: BasicValueType;
  innerValueType?: BasicValueType;

  constructor(token: Token) {
    this.token = token;
  }

  get numNodes(): number {
    return 1;
  }

  toString() {
    return `AstNode: ${this.token}::${this.name}`;
  }
}

export class BinaryOperatorNode extends AstNode {
  readonly left: AstNode;
  readonly right: AstNode;
  override readonly name = AstNodeType.BinaryOperatorNode;

  constructor(left: AstNode, token: Token, right: AstNode) {
    super(token);

    this.left = left;
    this.right = right;

    switch (token.type) {
      case TokenType.Add: {
        const isNumberType = ({ valueType, innerValueType, token }: AstNode) => {
          return valueType === BasicValueType.Number || innerValueType === BasicValueType.Number || token.value.toUpperCase() === 'BLANK';
        };
        if ([left, right].every(isNumberType)) {
          this.valueType = BasicValueType.Number;
          return;
        }

        this.valueType = BasicValueType.String;
        return;
      }

      case TokenType.Minus:
      case TokenType.Times:
      case TokenType.Mod:
      case TokenType.Div: {
        this.valueType = BasicValueType.Number;
        return;
      }

      case TokenType.Or:
      case TokenType.And:
      case TokenType.Equal:
      case TokenType.NotEqual:
      case TokenType.Greater:
      case TokenType.GreaterEqual:
      case TokenType.Less:
      case TokenType.LessEqual: {
        this.valueType = BasicValueType.Boolean;
        return;
      }

      case TokenType.Concat: {
        this.valueType = BasicValueType.String;
        return;
      }

      default: {
        throw new TypeError(`Function error: unknown operator ${token.type}`);
      }
    }
  }

  override get numNodes(): number {
    return 1 + this.left.numNodes + this.right.numNodes;
  }
}

export class UnaryOperatorNode extends AstNode {
  readonly child: AstNode;
  override readonly name = AstNodeType.UnaryOperatorNode;
  override readonly valueType: BasicValueType;

  constructor(child: AstNode, token: Token) {
    super(token);
    this.child = child;
    switch (token.type) {
      case TokenType.Minus:
        this.valueType = BasicValueType.Number;
        break;
      case TokenType.Not:
        this.valueType = BasicValueType.Boolean;
        break;
      case TokenType.Add:
        this.valueType = child.valueType;
        break;
      default:
        throw new Error(`unreachable ${token.value}`);
    }
  }

  override get numNodes(): number {
    return 1 + this.child.numNodes;
  }
}

export abstract class ValueOperandNodeBase extends AstNode {
  readonly value: string;
  // Context dependency removed for portability
  
  constructor(token: Token) {
    super(token);
    this.value = token.value.replace(/\\(.)/g, '$1');

    // Check for boolean literals TRUE/FALSE
    const upperCaseValue = this.value.toUpperCase();
    if (upperCaseValue === 'TRUE' || upperCaseValue === 'FALSE') {
      this.valueType = BasicValueType.Boolean;
    } else {
      // Simplified: Default to String if no context provided to resolve type
      this.valueType = BasicValueType.String; 
    }
  }
}

export class ValueOperandNode extends ValueOperandNodeBase {
  override readonly name = AstNodeType.ValueOperandNode;

  constructor(token: Token) {
    super(token);
    // Logic to bind to field context removed for basic parsing
  }
}

export class PureValueOperandNode extends ValueOperandNodeBase {
  override readonly name = AstNodeType.PureValueOperandNode;

  constructor(token: Token) {
    super(token);
  }
}

export class CallOperandNode extends AstNode {
  readonly value: string;
  override readonly name = AstNodeType.CallOperandNode;
  readonly params: AstNode[] = [];

  constructor(token: Token) {
    super(token);
    this.value = token.value;
  }

  override get numNodes(): number {
    return this.params.reduce((num, node) => num + node.numNodes, 1);
  }
}

export class NumberOperandNode extends AstNode {
  readonly value: string;
  override readonly name = AstNodeType.NumberOperandNode;
  override valueType = BasicValueType.Number;

  constructor(token: Token) {
    super(token);
    this.value = token.value;
  }
}

export class StringOperandNode extends AstNode {
  readonly value: string;
  override readonly name = AstNodeType.StringOperandNode;
  override valueType = BasicValueType.String;

  constructor(token: Token) {
    super(token);

    let tokenValue = token.value;
    const terminatorMap = new Map([
      [/\\n/g, '\n'], // newline
      [/\\r/g, '\r'], // newline
      [/\\t/g, '\t'], // tab
    ]);

    terminatorMap.forEach((v, k) => {
      tokenValue = tokenValue.replace(k, v);
    });
    // Remove surrounding quotes from the string literal
    if (tokenValue.startsWith('"') && tokenValue.endsWith('"')) {
        tokenValue = tokenValue.substring(1, tokenValue.length - 1);
    }
    this.value = tokenValue;
  }
}
