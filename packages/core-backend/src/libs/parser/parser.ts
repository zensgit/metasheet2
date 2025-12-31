
import type { ILexer } from './lexer';
import { Token, TokenType } from './token';
import {
  AstNode,
  BinaryOperatorNode,
  UnaryOperatorNode,
  ValueOperandNode,
  CallOperandNode,
  NumberOperandNode,
  StringOperandNode,
  PureValueOperandNode,
} from './ast';
import { FunctionRegistry } from '../formula'; // Link to our ported formula engine

/**
  * operator precedence
  */
const PriorityMap = new Map<TokenType, number>();
[
  [TokenType.Times, TokenType.Div, TokenType.Mod],
  [TokenType.Add, TokenType.Minus],
  [TokenType.Greater, TokenType.GreaterEqual, TokenType.Less, TokenType.LessEqual],
  [TokenType.Equal, TokenType.NotEqual],
  [TokenType.And],
  [TokenType.Or],
  [TokenType.Concat],
].forEach((arr, index) => arr.forEach(type => PriorityMap.set(type, index)));

export class FormulaExprParser {
  private currentToken: Token | null;

  constructor(public lexer: ILexer) {
    this.currentToken = this.lexer.getNextToken();
  }

  parse(): AstNode {
    const node = this.expr();
    if (this.currentToken != null) {
      console.error(this.currentToken);
      throw new Error(`Function error: unrecognized char ${this.currentToken.value}`);
    }
    return node;
  }

  private next(type: TokenType): Token | null {
    if (this.currentToken == null) {
      return null;
    }
    if (this.currentToken.type === type) {
      this.currentToken = this.lexer.getNextToken();
    } else {
      switch (type) {
        case TokenType.LeftParen:
          throw new SyntaxError('Function error: no left bracket');
        case TokenType.RightParen:
          throw new SyntaxError('Function error: end of right bracket');
      }
      throw new SyntaxError(`Function error: unable parse char ${this.currentToken.value}`);
    }
    return this.currentToken;
  }

  private factor(): AstNode {
    // factor : VALUE | LEFT_PAREN expr RIGHT_PAREN | NOT expr

    const token = this.currentToken;

    if (!token) {
      throw new Error('Function error: wrong function suffix');
    }

    switch (token.type) {
      // field variable: {value}
      case TokenType.Value: {
        this.next(TokenType.Value);
        // Removed SelfRefError check for basic parsing
        return new ValueOperandNode(token);
      }

      // field variable: value (without curly braces)
      case TokenType.PureValue: {
        this.next(TokenType.PureValue);
        // Removed SelfRefError check for basic parsing
        return new PureValueOperandNode(token);
      }

      // Preset functions: Sum/Average ...
      case TokenType.Call: {
        this.next(TokenType.Call);
        const node = new CallOperandNode(token);
        
        // Validation against our ported registry
        const funcName = node.value.toUpperCase();
        // @ts-ignore
        if (!FunctionRegistry[funcName]) {
             // We can optionally throw here or allow it for later validation
             // throw new TypeError(`Function error: not definition ${node.value}`);
        }

        this.next(TokenType.LeftParen);

        if (!this.currentToken) {
          throw new Error('Function error: end of right bracket');
        }

        while (this.currentToken.type !== TokenType.RightParen) {
          node.params.push(this.expr());
          if (!this.currentToken) {
            throw new Error('Function error: end of right bracket');
          }
          // Exclude multiple parameters without commas
          if (this.currentToken.type !== TokenType.Comma) {
            break;
          }
        }

        // Removed valueType inference from FuncClass for portability

        this.next(TokenType.RightParen);
        return node;
      }

      // number: 123.333
      case TokenType.Number: {
        this.next(TokenType.Number);
        return new NumberOperandNode(token);
      }

      // string: 'xyz'
      case TokenType.String: {
        this.next(TokenType.String);
        return new StringOperandNode(token);
      }

      // Left parenthesis: '('
      case TokenType.LeftParen: {
        this.next(TokenType.LeftParen);
        const node: AstNode = this.expr();
        this.next(TokenType.RightParen);
        return node;
      }

      // Negate sign (unary arithmetic sign): '!'
      case TokenType.Not: {
        this.next(TokenType.Not);
        const node: AstNode = this.factor();
        return new UnaryOperatorNode(node, token);
      }

      // + sign (unary arithmetic sign): '+'
      case TokenType.Add: {
        this.next(TokenType.Add);
        const node: AstNode = this.factor();
        return new UnaryOperatorNode(node, token);
      }

      // -sign (unary arithmetic sign): '-'
      case TokenType.Minus: {
        this.next(TokenType.Minus);
        const node: AstNode = this.factor();
        return new UnaryOperatorNode(node, token);
      }

      case TokenType.Comma: {
        this.next(TokenType.Comma);
        const node: AstNode = this.expr();
        return node;
      }

      case TokenType.Blank: {
        this.next(TokenType.Blank);
        return this.factor();
      }

      default:
        throw new Error(`Function error: unknown operator ${token.value}`);
    }
  }

  private expr(inner?: boolean): AstNode {
    // expr   : factor ((&& | ||) factor)*
    // factor : Number | String | Call | VALUE | LEFT_PAREN expr RIGHT_PAREN | NOT expr

    let node: AstNode = this.factor();

    while (this.currentToken &&
      [
        TokenType.And, TokenType.Or, TokenType.Add, TokenType.Times, TokenType.Div, TokenType.Minus,
        TokenType.Mod, TokenType.Concat, TokenType.Equal, TokenType.NotEqual, TokenType.Greater, TokenType.GreaterEqual,
        TokenType.Less, TokenType.LessEqual,
      ].includes(this.currentToken.type)
    ) {
      const token: Token = this.currentToken;
      this.next(token.type);
      if (!this.currentToken) {
        throw new Error('Function error: wrong function suffix');
      }
      let right: AstNode | undefined;
      let nextToken: Token | null = null;
      const currentToken = this.currentToken;
      const currentTokenIndex = this.lexer.currentTokenIndex;
      /**
        * Take a step forward, get the token and go back
        *
        * 1. If you encounter a function or left parenthesis, go forward to test the entire function or parenthesis content,
        * get the following operator and then fall back
        *
        * 2. If it is not a function, just try a token forward, get the operator and then fall back
        */
      if ([TokenType.Call, TokenType.LeftParen].includes(currentToken.type)) {
        this.factor();
        nextToken = this.currentToken;
        this.currentToken = currentToken;
        this.lexer.currentTokenIndex = currentTokenIndex;
      } else {
        nextToken = this.lexer.getNextToken();
        this.lexer.getPrevToken();
      }

      const currentOpIndex = PriorityMap.get(token.type);
      if (nextToken) {
        const nextOpIndex = PriorityMap.get(nextToken.type);

        if (currentOpIndex != null && nextOpIndex != null && nextOpIndex < currentOpIndex) {
          right = this.expr(true);
        }
        // When operators with different priorities are encountered in the loop, the recursion must be exited;
        if (inner && currentOpIndex != null && nextOpIndex != null && nextOpIndex > currentOpIndex) {
          return new BinaryOperatorNode(node, token, right || this.factor());
        }
      }
      node = new BinaryOperatorNode(node, token, right || this.factor());
    }
    // 1 + (1 + 3) * 2
    return node;
  }
}
