/** Optional async file output. Does not change DatyPlatform 1.0.0 downloadText. */
export interface DatyTextExports {
  VERSION: 'daty-text-export-v1';
  /** saved means the chosen file write has completed; a closed picker is cancelled.
   * Reject write/permission errors. Preserve UTF-8 text; do not log contents/paths.
   * No device commands or automatic retries. Honour cancellation before writing.
   */
  saveText(text: string, options: {
    fileName: string; mimeType: string; signal?: AbortSignal;
  }): Promise<{status: 'saved' | 'cancelled'}>;
}
export interface DatyTextExportFactory {
  VERSION: 'daty-text-export-v1';
  saveText(runtime: unknown, text: string, options: {
    fileName: string; mimeType: string; signal?: AbortSignal;
  }): Promise<{status: 'saved' | 'cancelled' | 'download-started'}>;
}
