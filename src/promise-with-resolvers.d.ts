/** Ambient for Promise.withResolvers (Node 22+ / ES2024). Runtime is Node >=20 with Node 22 available; tsconfig target stays ES2022. */
interface PromiseConstructor {
  withResolvers<T = unknown>(): {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
}
