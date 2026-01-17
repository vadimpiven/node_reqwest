declare module 'fd-lock' {
  export interface FdLockOptions {
    wait?: boolean;
    retry?: number;
    start?: number;
    length?: number;
  }

  export default class FdLock {
    constructor(fd: number, options?: FdLockOptions);
    ready(): Promise<void>;
    close(): Promise<void>;
  }
}
