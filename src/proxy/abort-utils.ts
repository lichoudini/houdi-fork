export function composeAbortSignal(params: {
  signal?: AbortSignal;
  timeoutMs?: number;
}): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (params.signal) {
    signals.push(params.signal);
  }
  if (typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
    signals.push(AbortSignal.timeout(Math.floor(params.timeoutMs)));
  }
  if (signals.length === 0) {
    return undefined;
  }
  if (signals.length === 1) {
    return signals[0];
  }
  return AbortSignal.any(signals);
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string' && name.toLowerCase() === 'aborterror') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /abort|cancel/i.test(message);
}

export function abortReasonToText(signal?: AbortSignal): string {
  if (!signal?.aborted) {
    return 'aborted';
  }
  const reason = signal.reason;
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message.trim();
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason.trim();
  }
  return 'aborted';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error(abortReasonToText(signal));
  error.name = 'AbortError';
  throw error;
}
