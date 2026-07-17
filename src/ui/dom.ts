/** Shared DOM guards for keyboard/pointer routing (audit #6 — one copy). */

/** Only text entry may swallow keys — a focused button must not. */
export function isTextEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}
