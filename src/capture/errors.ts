export class CaptureReadError extends Error {
  readonly agentError: unknown;
  readonly paneError: unknown;

  constructor(message: string, causes: { agentError: unknown; paneError: unknown }) {
    super(message);
    this.name = "CaptureReadError";
    this.agentError = causes.agentError;
    this.paneError = causes.paneError;
  }
}
