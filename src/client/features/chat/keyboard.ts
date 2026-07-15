export function submitsOnEnter(event: {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
}): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.isComposing;
}
