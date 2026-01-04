# TypeScript Errors + Tests (Chunk 3B)

## Problem/Purpose

Ensure that errors crossing the FFI boundary are correctly identified as Undici errors
in JavaScript, even when multiple versions of the library are present.

## Solution

Implement TypeScript error classes using `Symbol.for` as unique identifiers, allowing
`instanceof` parity across library instances.

## Architecture

```text
FFI Metadata (CoreErrorInfo)
  └─ createUndiciError()
       └─ new RequestAbortedError() [Symbol.for('undici.error.UND_ERR_ABORTED')]
```

## Implementation

### packages/node/export/errors.ts

```typescript
// SPDX-License-Identifier: Apache-2.0 OR MIT
const kUndiciError = Symbol.for('undici.error.UND_ERR');

export class UndiciError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'UndiciError';
    this.code = code;
  }
  static [Symbol.hasInstance](instance: any): boolean {
    return instance?.[kUndiciError] === true;
  }
  get [kUndiciError](): boolean { return true; }
}

const kRequestAbortedError = Symbol.for('undici.error.UND_ERR_ABORTED');
export class RequestAbortedError extends UndiciError {
  constructor(message = 'Request aborted') {
    super(message, 'UND_ERR_ABORTED');
    this.name = 'AbortError';
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kRequestAbortedError] === true; }
  get [kRequestAbortedError](): boolean { return true; }
}

const kConnectTimeoutError = Symbol.for('undici.error.UND_ERR_CONNECT_TIMEOUT');
export class ConnectTimeoutError extends UndiciError {
  constructor(message = 'Connect timeout') {
    super(message, 'UND_ERR_CONNECT_TIMEOUT');
    this.name = 'ConnectTimeoutError';
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kConnectTimeoutError] === true; }
  get [kConnectTimeoutError](): boolean { return true; }
}

const kHeadersTimeoutError = Symbol.for('undici.error.UND_ERR_HEADERS_TIMEOUT');
export class HeadersTimeoutError extends UndiciError {
  constructor(message = 'Headers timeout') {
    super(message, 'UND_ERR_HEADERS_TIMEOUT');
    this.name = 'HeadersTimeoutError';
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kHeadersTimeoutError] === true; }
  get [kHeadersTimeoutError](): boolean { return true; }
}

const kBodyTimeoutError = Symbol.for('undici.error.UND_ERR_BODY_TIMEOUT');
export class BodyTimeoutError extends UndiciError {
  constructor(message = 'Body timeout') {
    super(message, 'UND_ERR_BODY_TIMEOUT');
    this.name = 'BodyTimeoutError';
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kBodyTimeoutError] === true; }
  get [kBodyTimeoutError](): boolean { return true; }
}

const kSocketError = Symbol.for('undici.error.UND_ERR_SOCKET');
export class SocketError extends UndiciError {
  socket: any;
  constructor(message = 'Socket error', socket?: any) {
    super(message, 'UND_ERR_SOCKET');
    this.name = 'SocketError';
    this.socket = socket || null;
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kSocketError] === true; }
  get [kSocketError](): boolean { return true; }
}

const kInvalidArgumentError = Symbol.for('undici.error.UND_ERR_INVALID_ARG');
export class InvalidArgumentError extends UndiciError {
  constructor(message = 'Invalid argument') {
    super(message, 'UND_ERR_INVALID_ARG');
    this.name = 'InvalidArgumentError';
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kInvalidArgumentError] === true; }
  get [kInvalidArgumentError](): boolean { return true; }
}

const kClientDestroyedError = Symbol.for('undici.error.UND_ERR_DESTROYED');
export class ClientDestroyedError extends UndiciError {
  constructor(message = 'The client is destroyed') {
    super(message, 'UND_ERR_DESTROYED');
    this.name = 'ClientDestroyedError';
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kClientDestroyedError] === true; }
  get [kClientDestroyedError](): boolean { return true; }
}

const kClientClosedError = Symbol.for('undici.error.UND_ERR_CLOSED');
export class ClientClosedError extends UndiciError {
  constructor(message = 'The client is closed') {
    super(message, 'UND_ERR_CLOSED');
    this.name = 'ClientClosedError';
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kClientClosedError] === true; }
  get [kClientClosedError](): boolean { return true; }
}

const kRequestContentLengthMismatchError = Symbol.for('undici.error.UND_ERR_REQ_CONTENT_LENGTH_MISMATCH');
export class RequestContentLengthMismatchError extends UndiciError {
  constructor(message = 'Request body length does not match content-length header') {
    super(message, 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH');
    this.name = 'RequestContentLengthMismatchError';
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kRequestContentLengthMismatchError] === true; }
  get [kRequestContentLengthMismatchError](): boolean { return true; }
}

const kResponseContentLengthMismatchError = Symbol.for('undici.error.UND_ERR_RES_CONTENT_LENGTH_MISMATCH');
export class ResponseContentLengthMismatchError extends UndiciError {
  constructor(message = 'Response body length does not match content-length header') {
    super(message, 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH');
    this.name = 'ResponseContentLengthMismatchError';
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kResponseContentLengthMismatchError] === true; }
  get [kResponseContentLengthMismatchError](): boolean { return true; }
}

const kResponseExceededMaxSizeError = Symbol.for('undici.error.UND_ERR_RES_EXCEEDED_MAX_SIZE');
export class ResponseExceededMaxSizeError extends UndiciError {
  constructor(message = 'Response content exceeded max size') {
    super(message, 'UND_ERR_RES_EXCEEDED_MAX_SIZE');
    this.name = 'ResponseExceededMaxSizeError';
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kResponseExceededMaxSizeError] === true; }
  get [kResponseExceededMaxSizeError](): boolean { return true; }
}

const kNotSupportedError = Symbol.for('undici.error.UND_ERR_NOT_SUPPORTED');
export class NotSupportedError extends UndiciError {
  constructor(message = 'Not supported') {
    super(message, 'UND_ERR_NOT_SUPPORTED');
    this.name = 'NotSupportedError';
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kNotSupportedError] === true; }
  get [kNotSupportedError](): boolean { return true; }
}

const kResponseError = Symbol.for('undici.error.UND_ERR_RESPONSE');
export class ResponseError extends UndiciError {
  statusCode: number;
  body: any;
  headers: any;
  constructor(message: string, statusCode: number, options: { headers?: any; body?: any } = {}) {
    super(message, 'UND_ERR_RESPONSE');
    this.name = 'ResponseError';
    this.statusCode = statusCode;
    this.body = options.body || null;
    this.headers = options.headers || null;
  }
  static [Symbol.hasInstance](instance: any): boolean { return instance?.[kResponseError] === true; }
  get [kResponseError](): boolean { return true; }
}

export interface CoreErrorInfo {
  code: string;
  name: string;
  message: string;
  statusCode?: number;
}

export function createUndiciError(errorInfo: CoreErrorInfo): Error {
  const { code, message, statusCode } = errorInfo;
  switch (code) {
    case 'UND_ERR_ABORTED': return new RequestAbortedError(message);
    case 'UND_ERR_CONNECT_TIMEOUT': return new ConnectTimeoutError(message);
    case 'UND_ERR_HEADERS_TIMEOUT': return new HeadersTimeoutError(message);
    case 'UND_ERR_BODY_TIMEOUT': return new BodyTimeoutError(message);
    case 'UND_ERR_SOCKET': return new SocketError(message);
    case 'UND_ERR_DESTROYED': return new ClientDestroyedError(message);
    case 'UND_ERR_CLOSED': return new ClientClosedError(message);
    case 'UND_ERR_INVALID_ARG': return new InvalidArgumentError(message);
    case 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH': return new RequestContentLengthMismatchError(message);
    case 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH': return new ResponseContentLengthMismatchError(message);
    case 'UND_ERR_RES_EXCEEDED_MAX_SIZE': return new ResponseExceededMaxSizeError(message);
    case 'UND_ERR_NOT_SUPPORTED': return new NotSupportedError(message);
    case 'UND_ERR_RESPONSE': return new ResponseError(message, statusCode || 500);
    default: return new UndiciError(message, code);
  }
}
```

### packages/node/tests/vitest/errors.test.ts

```typescript
import { describe, it, expect } from 'vitest';
import {
  UndiciError,
  RequestAbortedError,
  ConnectTimeoutError,
  SocketError,
  ResponseError,
  createUndiciError,
  type CoreErrorInfo,
} from '../../export/errors';

describe('Undici Error Classes', () => {
  it('should create correct error instances', () => {
    const abortError = new RequestAbortedError();
    expect(abortError.code).toBe('UND_ERR_ABORTED');
    expect(abortError.name).toBe('AbortError');
    expect(abortError.message).toBe('Request aborted');

    const timeoutError = new ConnectTimeoutError('Custom timeout');
    expect(timeoutError.code).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(timeoutError.message).toBe('Custom timeout');
  });

  it('should support instanceof checks', () => {
    const abortError = new RequestAbortedError();
    expect(abortError instanceof RequestAbortedError).toBe(true);
    expect(abortError instanceof UndiciError).toBe(true);
    expect(abortError instanceof Error).toBe(true);
  });

  it('should support cross-library instanceof via Symbol.for', () => {
    const error = new RequestAbortedError();
    const kAbort = Symbol.for('undici.error.UND_ERR_ABORTED');
    const kUndici = Symbol.for('undici.error.UND_ERR');
    expect(error[kAbort]).toBe(true);
    expect(error[kUndici]).toBe(true);
  });

  it('should create errors from CoreErrorInfo', () => {
    const errorInfo: CoreErrorInfo = {
      code: 'UND_ERR_ABORTED',
      name: 'AbortError',
      message: 'Request was aborted',
    };
    const error = createUndiciError(errorInfo);
    expect(error instanceof RequestAbortedError).toBe(true);
    expect(error.message).toBe('Request was aborted');
  });

  it('should handle ResponseError with status code', () => {
    const errorInfo: CoreErrorInfo = {
      code: 'UND_ERR_RESPONSE',
      name: 'ResponseError',
      message: 'Bad request',
      statusCode: 400,
    };
    const error = createUndiciError(errorInfo) as ResponseError;
    expect(error instanceof ResponseError).toBe(true);
    expect(error.statusCode).toBe(400);
  });

  it('should fallback to UndiciError for unknown codes', () => {
    const errorInfo: CoreErrorInfo = {
      code: 'UND_ERR_UNKNOWN',
      name: 'UnknownError',
      message: 'Unknown error occurred',
    };
    const error = createUndiciError(errorInfo);
    expect(error instanceof UndiciError).toBe(true);
    expect(error.code).toBe('UND_ERR_UNKNOWN');
  });
});
```

## Tables

| Metric | Value |
| :--- | :--- |
| **JS Runtime** | Node.js / Bun / Deno |
| **Instance Test** | `Symbol.for('undici.error.*')` |
| **Error Classes** | 14 (13 specific + 1 base) |

## File Structure

```text
packages/node/
├── export/
│   └── errors.ts
└── tests/vitest/
    └── errors.test.ts
```
