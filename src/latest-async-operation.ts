export interface LatestAsyncOperationCallbacks<T> {
  onSuccess: (value: T) => void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
}

export function createLatestAsyncOperation() {
  let generation = 0;

  return Object.freeze({
    invalidate() {
      generation += 1;
    },
    run<T>(
      operation: () => Promise<T>,
      callbacks: LatestAsyncOperationCallbacks<T>,
    ): Promise<void> {
      const currentGeneration = generation + 1;
      generation = currentGeneration;
      return Promise.resolve()
        .then(operation)
        .then(
          (value) => {
            if (generation === currentGeneration) callbacks.onSuccess(value);
          },
          (error) => {
            if (generation === currentGeneration) callbacks.onError(error);
          },
        )
        .finally(() => {
          if (generation === currentGeneration) callbacks.onSettled?.();
        });
    },
  });
}
