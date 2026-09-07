// Register a disposer before awaiting acquisition. A failed cleanup must not
// prevent the other resources from being released.
export function createCleanup() {
  let promise;
  const disposers = [];
  return {
    add(dispose) {
      if (promise) throw new Error('SESSION_ALREADY_ENDING');
      disposers.push(dispose);
    },
    close() {
      if (!promise) promise = Promise.resolve().then(async () => {
        const failures = [];
        for (const dispose of disposers.reverse()) {
          try { await dispose(); } catch { failures.push('RESOURCE_RELEASE_FAILED'); }
        }
        return failures;
      });
      return promise;
    },
  };
}
