/**
 * Immediately-invoked function expression.
 *
 * @param fn - The function to execute
 * @returns The result of the function
 */
export const iife = <T>(fn: () => T) => fn();
