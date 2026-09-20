export type SerialQueue = <T>(task: () => Promise<T> | T) => Promise<T>;

export function createSerialQueue(): SerialQueue {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T> | T): Promise<T> => {
    const next = chain.then(task);
    chain = next.catch(() => undefined);
    return next;
  };
}
