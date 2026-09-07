export interface CopyReport {
  provider: string;
  confirmed: boolean;
}

export interface ClipboardProvider {
  readonly name: string;
  copy(text: string): Promise<CopyReport>;
}

export class ClipboardError extends Error {
  readonly attempts: readonly string[];

  constructor(message: string, attempts: readonly string[]) {
    super(message);
    this.name = "ClipboardError";
    this.attempts = Object.freeze([...attempts]);
  }
}
