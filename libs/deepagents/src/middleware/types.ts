import type { Runtime } from "langchain";

type PromiseOrValue<T> = T | Promise<T>;

/**
 * access middleware hooks directly is not straightforward as it can be
 * a function or an object with a function. To simplify testing, we define a
 * type that can be used to access the middleware hooks.
 */
export type MiddlewareHandler<TSchema$1 = any, TContext = unknown> = (
  state: TSchema$1,
  runtime: Runtime<TContext> | ((...args: any[]) => any),
) => PromiseOrValue<any>;
