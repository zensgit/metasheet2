/**
 * RPC Error Handler
 * Issue #30: Standardized error handling for RPC
 */
export var RPCErrorCode;
(function (RPCErrorCode) {
    // Client errors
    RPCErrorCode["INVALID_REQUEST"] = "INVALID_REQUEST";
    RPCErrorCode["UNAUTHORIZED"] = "UNAUTHORIZED";
    RPCErrorCode["FORBIDDEN"] = "FORBIDDEN";
    RPCErrorCode["NOT_FOUND"] = "NOT_FOUND";
    RPCErrorCode["CONFLICT"] = "CONFLICT";
    RPCErrorCode["VALIDATION_ERROR"] = "VALIDATION_ERROR";
    // Server errors
    RPCErrorCode["INTERNAL_ERROR"] = "INTERNAL_ERROR";
    RPCErrorCode["SERVICE_UNAVAILABLE"] = "SERVICE_UNAVAILABLE";
    RPCErrorCode["TIMEOUT"] = "TIMEOUT";
    RPCErrorCode["CIRCUIT_BREAKER_OPEN"] = "CIRCUIT_BREAKER_OPEN";
    // Network errors
    RPCErrorCode["NETWORK_ERROR"] = "NETWORK_ERROR";
    RPCErrorCode["CONNECTION_REFUSED"] = "CONNECTION_REFUSED";
    RPCErrorCode["CONNECTION_TIMEOUT"] = "CONNECTION_TIMEOUT";
})(RPCErrorCode || (RPCErrorCode = {}));
export class RPCError extends Error {
    code;
    details;
    retriable;
    statusCode;
    timestamp;
    requestId;
    topic;
    constructor(errorDetails) {
        super(errorDetails.message);
        this.name = 'RPCError';
        this.code = errorDetails.code;
        this.details = errorDetails.details;
        this.retriable = errorDetails.retriable ?? this.isRetriableCode(errorDetails.code);
        this.statusCode = errorDetails.statusCode ?? this.getStatusCodeForError(errorDetails.code);
        this.timestamp = errorDetails.timestamp ?? new Date().toISOString();
        this.requestId = errorDetails.requestId;
        this.topic = errorDetails.topic;
        // Maintains proper stack trace
        Error.captureStackTrace(this, RPCError);
    }
    isRetriableCode(code) {
        const retriableCodes = [
            RPCErrorCode.SERVICE_UNAVAILABLE,
            RPCErrorCode.TIMEOUT,
            RPCErrorCode.NETWORK_ERROR,
            RPCErrorCode.CONNECTION_REFUSED,
            RPCErrorCode.CONNECTION_TIMEOUT
        ];
        return retriableCodes.includes(code);
    }
    getStatusCodeForError(code) {
        const statusCodeMap = {
            [RPCErrorCode.INVALID_REQUEST]: 400,
            [RPCErrorCode.UNAUTHORIZED]: 401,
            [RPCErrorCode.FORBIDDEN]: 403,
            [RPCErrorCode.NOT_FOUND]: 404,
            [RPCErrorCode.CONFLICT]: 409,
            [RPCErrorCode.VALIDATION_ERROR]: 422,
            [RPCErrorCode.INTERNAL_ERROR]: 500,
            [RPCErrorCode.SERVICE_UNAVAILABLE]: 503,
            [RPCErrorCode.TIMEOUT]: 504,
            [RPCErrorCode.CIRCUIT_BREAKER_OPEN]: 503,
            [RPCErrorCode.NETWORK_ERROR]: 502,
            [RPCErrorCode.CONNECTION_REFUSED]: 502,
            [RPCErrorCode.CONNECTION_TIMEOUT]: 504
        };
        return statusCodeMap[code] || 500;
    }
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            details: this.details,
            retriable: this.retriable,
            statusCode: this.statusCode,
            timestamp: this.timestamp,
            requestId: this.requestId,
            topic: this.topic
        };
    }
}
export class RPCErrorHandler {
    /**
     * Wrap error in standard RPC error format
     */
    static wrapError(error, context) {
        // Already an RPCError
        if (error instanceof RPCError) {
            return error;
        }
        // Network errors
        if (error.code === 'ECONNREFUSED') {
            return new RPCError({
                code: RPCErrorCode.CONNECTION_REFUSED,
                message: 'Connection refused to RPC service',
                details: { originalError: error.message },
                ...context
            });
        }
        if (error.code === 'ETIMEDOUT' || error.code === 'TIMEOUT') {
            return new RPCError({
                code: RPCErrorCode.TIMEOUT,
                message: 'RPC request timed out',
                details: { originalError: error.message },
                ...context
            });
        }
        if (error.code === 'ENOTFOUND' || error.code === 'ENETUNREACH') {
            return new RPCError({
                code: RPCErrorCode.NETWORK_ERROR,
                message: 'Network error during RPC request',
                details: { originalError: error.message },
                ...context
            });
        }
        // Validation errors
        if (error.name === 'ValidationError' || error.type === 'validation') {
            return new RPCError({
                code: RPCErrorCode.VALIDATION_ERROR,
                message: error.message || 'Validation failed',
                details: error.details || error.errors,
                ...context
            });
        }
        // Auth errors
        if (error.statusCode === 401 || error.code === 'UNAUTHORIZED') {
            return new RPCError({
                code: RPCErrorCode.UNAUTHORIZED,
                message: error.message || 'Unauthorized',
                ...context
            });
        }
        if (error.statusCode === 403 || error.code === 'FORBIDDEN') {
            return new RPCError({
                code: RPCErrorCode.FORBIDDEN,
                message: error.message || 'Forbidden',
                ...context
            });
        }
        // Default to internal error
        return new RPCError({
            code: RPCErrorCode.INTERNAL_ERROR,
            message: error.message || 'Internal RPC error',
            details: {
                originalError: error.message,
                stack: error.stack
            },
            ...context
        });
    }
    /**
     * Create standard error response
     */
    static createErrorResponse(error) {
        return {
            success: false,
            error: error.toJSON()
        };
    }
    /**
     * Create standard success response
     */
    static createSuccessResponse(data, meta) {
        const response = {
            success: true,
            data
        };
        if (meta) {
            response.meta = {
                ...meta,
                timestamp: new Date().toISOString()
            };
        }
        return response;
    }
    /**
     * Extract error message for logging
     */
    static getErrorMessage(error) {
        if (error instanceof RPCError) {
            return `[${error.code}] ${error.message}`;
        }
        if (error instanceof Error) {
            return error.message;
        }
        if (typeof error === 'string') {
            return error;
        }
        return 'Unknown error';
    }
    /**
     * Check if error should be retried
     */
    static shouldRetry(error, attempt, maxRetries) {
        if (attempt >= maxRetries) {
            return false;
        }
        if (error instanceof RPCError) {
            return error.retriable;
        }
        // Check for retriable error codes
        const retriableCodes = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH'];
        if (error.code && retriableCodes.includes(error.code)) {
            return true;
        }
        // Check for retriable status codes
        const retriableStatusCodes = [502, 503, 504];
        if (error.statusCode && retriableStatusCodes.includes(error.statusCode)) {
            return true;
        }
        return false;
    }
    /**
     * Calculate retry delay with exponential backoff
     */
    static getRetryDelay(attempt, baseDelay = 100) {
        const jitter = Math.random() * 100;
        return Math.min(Math.pow(2, attempt) * baseDelay + jitter, 30000);
    }
    /**
     * Format error for user display
     */
    static formatUserMessage(error) {
        if (error instanceof RPCError) {
            switch (error.code) {
                case RPCErrorCode.TIMEOUT:
                    return 'The request took too long to complete. Please try again.';
                case RPCErrorCode.SERVICE_UNAVAILABLE:
                    return 'The service is temporarily unavailable. Please try again later.';
                case RPCErrorCode.UNAUTHORIZED:
                    return 'You are not authorized to perform this action.';
                case RPCErrorCode.FORBIDDEN:
                    return 'You do not have permission to access this resource.';
                case RPCErrorCode.NOT_FOUND:
                    return 'The requested resource was not found.';
                case RPCErrorCode.VALIDATION_ERROR:
                    return 'The request contains invalid data. Please check and try again.';
                case RPCErrorCode.NETWORK_ERROR:
                    return 'A network error occurred. Please check your connection.';
                case RPCErrorCode.CIRCUIT_BREAKER_OPEN:
                    return 'The service is experiencing issues. Please try again later.';
                default:
                    return 'An unexpected error occurred. Please try again.';
            }
        }
        return 'An unexpected error occurred. Please try again.';
    }
}
//# sourceMappingURL=rpc-error-handler.js.map