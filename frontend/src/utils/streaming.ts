export interface StreamDeltaBuffer {
  push(delta: string): void;
  flushNow(): void;
  clear(): void;
  readonly hasPending: boolean;
}

export function createStreamDeltaBuffer(onFlush: (delta: string) => void): StreamDeltaBuffer {
  let pending = '';
  let frame: number | null = null;

  function flush(): void {
    frame = null;
    const delta = pending;
    pending = '';
    if (delta) onFlush(delta);
  }

  function cancelFrame(): void {
    if (frame === null) return;
    cancelAnimationFrame(frame);
    frame = null;
  }

  return {
    push(delta: string): void {
      if (!delta) return;
      pending += delta;
      if (frame !== null) return;
      frame = requestAnimationFrame(flush);
    },
    flushNow(): void {
      cancelFrame();
      flush();
    },
    clear(): void {
      cancelFrame();
      pending = '';
    },
    get hasPending(): boolean {
      return Boolean(pending);
    },
  };
}

export function isNearScrollBottom(el: HTMLElement, threshold = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export function scrollToBottomIfPinned(el: HTMLElement | null, wasPinned: boolean): void {
  if (!el || !wasPinned) return;
  el.scrollTop = el.scrollHeight;
}
