/**
 * RPC Error Handler
 * Issue #30: Standardized error handling for RPC
 */
export declare enum RPCErrorCode {
    INVALID_REQUEST = "INVALID_REQUEST",
    UNAUTHORIZED = "UNAUTHORIZED",
    FORBIDDEN = "FORBIDDEN",
    NOT_FOUND = "NOT_FOUND",
    CONFLICT = "CONFLICT",
    VALIDATION_ERROR = "VALIDATION_ERROR",
    INTERNAL_ERROR = "INTERNAL_ERROR",
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
    TIMEOUT = "TIMEOUT",
    CIRCUIT_BREAKER_OPEN = "CIRCUIT_BREAKER_OPEN",
    NETWORK_ERROR = "NETWORK_ERROR",
    CONNECTION_REFUSED = "CONNECTION_REFUSED",
    CONNECTION_TIMEOUT = "CONNECTION_TIMEOUT"
}
export interface RPCErrorDetails {
    code: RPCErrorCode;
    message: string;
    details?: any;
    retriable?: boolean;
    statusCode?: number;
    timestamp?: string;
    requestId?: string;
    topic?: string;
}
export declare class RPCError extends Error {
    code: RPCErrorCode;
    details?: any;
    retriable: boolean;
    statusCode: number;
    timestamp: string;
    requestId?: string;
    topic?: string;
    constructor(errorDetails: RPCErrorDetails);
    private isRetriableCode;
    private getStatusCodeForError;
    toJSON(): RPCErrorDetails;
}
export declare class RPCErrorHandler {
    /**
     * Wrap error in standard RPC error format
     */
    static wrapError(error: any, context?: {
        requestId?: string;
        topic?: string;
    }): RPCError;
    /**
     * Create standard error response
     */
    static createErrorResponse(error: RPCError): {
        success: false;
        error: RPCErrorDetails;
    };
    /**
     * Create standard success response
     */
    static createSuccessResponse(data: any, meta?: {
        requestId?: string;
        duration?: number;
    }): {
        success: true;
        data: any;
        meta?: any;
    };
    /**
     * Extract error message for logging
     */
    static getErrorMessage(error: any): string;
    /**
     * Check if error should be retried
     */
    static shouldRetry(error: any, attempt: number, maxRetries: number): boolean;
    /**
     * Calculate retry delay with exponential backoff
     */
    static getRetryDelay(attempt: number, baseDelay?: number): number;
    /**
     * Format error for user display
     */
    static formatUserMessage(error: any): string;
}
//# sourceMappingURL=rpc-error-handler.d.ts.map