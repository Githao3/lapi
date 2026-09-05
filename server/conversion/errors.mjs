// Shared error type for the conversion layer.
// Thrown by any converter when a payload cannot be faithfully converted;
// the caller (relay.js) decides status: request-side → 400 (client fault),
// upstream-response-side → 502 (upstream fault).
export class ConversionError extends Error {
  constructor(message) {
    super(String(message));
    this.name = 'ConversionError';
  }
}