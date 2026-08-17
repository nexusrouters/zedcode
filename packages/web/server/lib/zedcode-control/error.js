export class ZedCodeControlError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = 'ZedCodeControlError';
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

export const asControlError = (error, fallbackMessage, fallbackStatus = 500) => {
  if (error instanceof ZedCodeControlError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new ZedCodeControlError(message || fallbackMessage, Number(error?.statusCode) || fallbackStatus, {
    ...(error?.goalConfigured === true ? { goalConfigured: true } : {}),
  });
};
