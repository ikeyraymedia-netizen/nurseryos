import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';

/** Lets token checks read the current request without threading it through every route. */
export const requestContext = new AsyncLocalStorage<{ req: Request }>();
