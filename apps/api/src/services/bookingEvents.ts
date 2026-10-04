import type { BookingEvent } from "@townplay/shared";

/** In-process fan-out of booking changes; Socket.io (realtime.ts) and tests subscribe. */
export class BookingEventBus {
  private readonly listeners = new Set<(e: BookingEvent) => void>();

  subscribe(listener: (e: BookingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: BookingEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
