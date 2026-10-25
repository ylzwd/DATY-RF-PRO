/** Optional file-input capability, independent of DatyPlatform 1.0.0 and Bridge DTOs.
 * No device command, storage write or parser is implemented by this port.
 * Full semantics and byte limits: docs/text-file-input.md.
 */
export interface TextFileOptions {
  accept: string;
  maxBytes: number; // positive safe integer; UTF-8 bytes, not string.length
  signal?: AbortSignal;
}

export interface CompletedTextFile {
  status: 'completed';
  name: string; // display basename only, never absolute path
  text: string;
  sizeBytes: number; // nonnegative safe integer; also checked against actual text
}

export interface CancelledTextFile { status: 'cancelled'; }
export type TextFileResult = CompletedTextFile | CancelledTextFile;

export interface TextFilePort {
  VERSION: 'daty-text-file-v1';
  openText(options: TextFileOptions): Promise<TextFileResult>;
  // I/O/validation failures reject. Cancellation resolves cancelled, not an empty file.
}

export type LatestTextFileResult = CancelledTextFile | (CompletedTextFile & {
  isCurrent(): boolean; // local coordinator guard; not serialized over IPC
});

/** Local openLatest rejection wrapper, never serialized as an IPC result. */
export interface TextFileError extends Error {
  name: 'TextFileError';
  cause: unknown;
  isCurrent(): boolean;
}

export interface TextFileRuntime {
  DatyPlatform?: {kind: string};
  DatyTextFiles?: TextFilePort;
  AbortController?: typeof AbortController;
  addEventListener?(type: 'pagehide', listener: () => void): void;
}

export interface TextFileFactory {
  VERSION: 'daty-text-file-v1';
  create(port: TextFilePort): TextFilePort;
  createBrowser(browser: Window): TextFilePort;
  openLatest(runtime: TextFileRuntime, options: TextFileOptions): Promise<LatestTextFileResult>;
  cancelPending(runtime: TextFileRuntime): void;
}
