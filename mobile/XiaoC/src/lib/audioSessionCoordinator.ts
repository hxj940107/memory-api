// Reserving call ownership is synchronous: no new chat operation may start
// while a recording/playback operation already in flight is being drained.
export class AudioSessionCoordinator {
  private callClaimed = false;
  private pending = new Set<Promise<unknown>>();
  private cleanups = new Set<() => Promise<void>>();

  get isCallOwner() { return this.callClaimed; }

  registerChatCleanup(cleanup: () => Promise<void>) {
    this.cleanups.add(cleanup);
    return () => { this.cleanups.delete(cleanup); };
  }

  async chatOperation<T>(operation: () => Promise<T>): Promise<T | undefined> {
    if (this.callClaimed) return undefined;
    const task = Promise.resolve().then(operation);
    this.pending.add(task);
    try { return await task; } finally { this.pending.delete(task); }
  }

  async acquireCall(): Promise<() => void> {
    if (this.callClaimed) throw new Error('AUDIO_ALREADY_OWNED');
    this.callClaimed = true;
    try {
      await Promise.allSettled([...this.pending]);
      for (const cleanup of this.cleanups) await cleanup();
    } catch (error) {
      this.callClaimed = false;
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.callClaimed = false;
    };
  }
}

export const audioSessionCoordinator = new AudioSessionCoordinator();
