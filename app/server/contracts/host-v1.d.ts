/** B3 optional facilities; DatyPlatform 1.0.0 four ports are unchanged.
 * Install injected capabilities before the application scripts. No device API.
 */
export interface DatyHostRuntime {
  VERSION: 'daty-host-runtime-v1';
  /** Synchronous registration, deferred callbacks. IDs stay inside the factory. */
  setTimeout(callback: () => unknown, delayMs: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(callback: () => unknown, delayMs: number): unknown;
  clearInterval(id: unknown): void;
  nowEpochMs(): number;
  nowMonotonicMs(): number;
}
/** Never return a Promise from these legacy synchronous UI calls.
 * A native app with only async confirmation must migrate the caller first.
 */
export interface DatyHostMessages {
  VERSION: 'daty-host-messages-v1';
  confirm(message: string): boolean;
  alert(message: string): void;
  notify(icon: string, title: string, message: string): void;
}
export interface DialogOptions {
  title?: string; message?: string; footnote?: string;
  confirmLabel?: string; cancelLabel?: string;
  rows?: Record<string, unknown>[];
  columns?: {key: string; label: string; numeric?: boolean}[];
  warnings?: string[];
  /** Optional app history presentation; no business execution inside the dialog. */
  symbol?: string; eyebrow?: string; tone?: 'danger';
  details?: {label: string; value: unknown}[];
}
/** Existing injection without VERSION remains compatible; new hosts set v1. */
export interface DatyDialogs {
  VERSION?: 'daty-dialogs-v1';
  confirm(options?: DialogOptions): Promise<boolean>;
  cancelActive(): void;
}
