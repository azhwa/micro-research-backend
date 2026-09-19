const activeCancellations = new Map<string, AbortController>();

export class ResearchCancelledError extends Error {
  constructor() {
    super("Research dibatalkan oleh user");
    this.name = "ResearchCancelledError";
  }
}

export function registerResearchCancellation(
  researchRunId: string,
  controller: AbortController
): void {
  activeCancellations.set(researchRunId, controller);
}

export function unregisterResearchCancellation(
  researchRunId: string,
  controller: AbortController
): void {
  if (activeCancellations.get(researchRunId) === controller) {
    activeCancellations.delete(researchRunId);
  }
}

export function requestResearchCancellation(researchRunId: string): boolean {
  const controller = activeCancellations.get(researchRunId);
  if (!controller || controller.signal.aborted) return false;
  controller.abort();
  return true;
}

export function throwIfResearchCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ResearchCancelledError();
}
