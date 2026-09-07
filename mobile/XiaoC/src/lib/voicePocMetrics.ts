// Only compare monotonic timestamps from the same clock domain. SDK callbacks
// are diagnostics, never evidence that sound physically reached the speaker.
export class VoicePocMetrics {
  private events: { name: string; at: number; domain: string }[] = [];
  mark(name: string, domain = 'phone', at = performance.now()) {
    if (!Number.isFinite(at)) return;
    this.events.push({ name, domain, at });
    if (this.events.length > 256) this.events.shift();
  }
  samples(start: string, end: string, domain: string) {
    const values: number[] = [];
    let pending: number | undefined;
    for (const event of this.events) {
      if (event.domain !== domain) continue;
      if (event.name === start) pending = event.at;
      if (event.name === end && pending !== undefined) {
        if (event.at >= pending) values.push(event.at - pending);
        pending = undefined;
      }
    }
    values.sort((a, b) => a - b);
    return {
      count: values.length,
      p50: values.length ? values[Math.ceil(values.length * 0.5) - 1] : null,
      p95: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
    };
  }
}
