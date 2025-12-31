
import {
  AstNode,
  AstNodeType,
  BinaryOperatorNode,
  UnaryOperatorNode,
  ValueOperandNode,
  StringOperandNode,
  CallOperandNode,
  NumberOperandNode,
  PureValueOperandNode,
} from '../parser/ast';
import { TokenType } from '../parser/token';
import { FunctionRegistry, FunctionName } from './index';
import { BaseValueObject, FormulaError } from './base'; // Import FormulaError
import { FormulaContext } from './context'; // Import FormulaContext

// Simplified resolver function (e.g. for retrieving variable values)
export type ResolverFunction = (key: string) => any;

export class Interpreter {
  constructor(private resolver?: ResolverFunction, private context?: FormulaContext) {}

  public visit(node: AstNode): BaseValueObject { // Ensure visit returns BaseValueObject
    if (!node) {
      return BaseValueObject.create(new FormulaError('#NULL!')); // Return error object
    }
    
    // Explicitly bind 'this' to methods in the switch statement to prevent context loss
    switch (node.name) {
      case AstNodeType.BinaryOperatorNode:
        return this.visitBinaryOperatorNode(node as BinaryOperatorNode);
      case AstNodeType.UnaryOperatorNode:
        return this.visitUnaryOperatorNode(node as UnaryOperatorNode);
      case AstNodeType.StringOperandNode:
        return this.visitStringOperandNode(node as StringOperandNode);
      case AstNodeType.NumberOperandNode:
        return this.visitNumberOperandNode(node as NumberOperandNode);
      case AstNodeType.ValueOperandNode:
      case AstNodeType.PureValueOperandNode:
        return this.visitValueOperandNode(node as ValueOperandNode | PureValueOperandNode);
      case AstNodeType.CallOperandNode:
        return this.visitCallOperatorNode(node as CallOperandNode);
      default:
        return BaseValueObject.create(new FormulaError(`#ERROR! Unexpected AST Node Type: ${node.name}`));
    }
  }

  private visitBinaryOperatorNode(node: BinaryOperatorNode): BaseValueObject {
    const left = this.visit(node.left);
    const right = this.visit(node.right);
    const type = node.token.type;

    if (left.isError()) return left;
    if (right.isError()) return right;

    const leftValue = left.getValue();
    const rightValue = right.getValue();

    switch (type) {
      case TokenType.Add: return BaseValueObject.create(Number(leftValue) + Number(rightValue));
      case TokenType.Minus: return BaseValueObject.create(Number(leftValue) - Number(rightValue));
      case TokenType.Times: return BaseValueObject.create(Number(leftValue) * Number(rightValue));
      case TokenType.Div: 
        if (Number(rightValue) === 0) return BaseValueObject.create(new FormulaError('#DIV/0!'));
        return BaseValueObject.create(Number(leftValue) / Number(rightValue));
      case TokenType.Mod: 
        if (Number(rightValue) === 0) return BaseValueObject.create(new FormulaError('#DIV/0!'));
        return BaseValueObject.create(Number(leftValue) % Number(rightValue));
      case TokenType.Equal: return BaseValueObject.create(leftValue == rightValue);
      case TokenType.NotEqual: return BaseValueObject.create(leftValue != rightValue);
      case TokenType.Greater: return BaseValueObject.create(leftValue > rightValue);
      case TokenType.GreaterEqual: return BaseValueObject.create(leftValue >= rightValue);
      case TokenType.Less: return BaseValueObject.create(leftValue < rightValue);
      case TokenType.LessEqual: return BaseValueObject.create(leftValue <= rightValue);
      case TokenType.Concat: return BaseValueObject.create(String(leftValue) + String(rightValue));
      case TokenType.And: return BaseValueObject.create(Boolean(leftValue && rightValue));
      case TokenType.Or: return BaseValueObject.create(Boolean(leftValue || rightValue));
      default: return BaseValueObject.create(new FormulaError(`Unknown operator: ${type}`));
    }
  }

  private visitUnaryOperatorNode(node: UnaryOperatorNode): BaseValueObject {
    const value = this.visit(node.child);
    if (value.isError()) return value;

    const val = value.getValue();
    switch (node.token.type) {
        case TokenType.Minus: return BaseValueObject.create(-Number(val));
        case TokenType.Not: return BaseValueObject.create(!Boolean(val));
        case TokenType.Add: return BaseValueObject.create(+Number(val));
        default: return BaseValueObject.create(new FormulaError(`Unknown unary operator: ${node.token.type}`));
    }
  }

  private visitStringOperandNode(node: StringOperandNode): BaseValueObject {
    return BaseValueObject.create(node.value);
  }

  private visitNumberOperandNode(node: NumberOperandNode): BaseValueObject {
    return BaseValueObject.create(Number(node.value));
  }

  private visitValueOperandNode(node: ValueOperandNode | PureValueOperandNode): BaseValueObject {
    const key = node.value;

    // Handle boolean literals TRUE/FALSE directly
    const upperCaseKey = key.toUpperCase();
    if (upperCaseKey === 'TRUE') {
        return BaseValueObject.create(true);
    }
    if (upperCaseKey === 'FALSE') {
        return BaseValueObject.create(false);
    }

    if (this.resolver) {
      // The resolver function in BaseFunction expects BaseValueObject
      // The test's mock resolver returns raw value, so we wrap it
      return BaseValueObject.create(this.resolver(key));
    }
    return BaseValueObject.create(null);
  }

  private visitCallOperatorNode(node: CallOperandNode): BaseValueObject {
    const funcName = node.value.toUpperCase();
    const func = FunctionRegistry[funcName as FunctionName];

    if (!func) {
      return BaseValueObject.create(new FormulaError(`#NAME? Function ${funcName} not defined.`));
    }

    const args = node.params.map(param => {
       // visit returns BaseValueObject, so direct passing is fine
       return this.visit(param);
    });

    const result = func.calculate(...args);
    
    // func.calculate already returns BaseValueObject, so no need for getValue() here
    return result;
  }
}
