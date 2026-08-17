import type { Session } from '@opencode-ai/sdk/v2';

export type SessionMetadataRecord = Record<string, unknown>;

type ZedCodeMetadata = {
  kind?: 'review';
  originalSessionID?: string;
  reviewSessionID?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const getSessionMetadata = (session: Session | null | undefined): SessionMetadataRecord => {
  const metadata = (session as (Session & { metadata?: unknown }) | null | undefined)?.metadata;
  return isRecord(metadata) ? metadata : {};
};

const getZedCodeMetadata = (metadata: SessionMetadataRecord): ZedCodeMetadata => {
  const value = metadata.zedcode;
  return isRecord(value) ? value as ZedCodeMetadata : {};
};

export const getReviewSessionID = (session: Session | null | undefined): string | null => {
  const value = getZedCodeMetadata(getSessionMetadata(session)).reviewSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const getOriginalSessionID = (session: Session | null | undefined): string | null => {
  const value = getZedCodeMetadata(getSessionMetadata(session)).originalSessionID;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
};

export const isReviewSession = (session: Session | null | undefined): boolean =>
  getZedCodeMetadata(getSessionMetadata(session)).kind === 'review' && Boolean(getOriginalSessionID(session));

export const withReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getZedCodeMetadata(metadata);
  return {
    ...metadata,
    zedcode: {
      ...current,
      reviewSessionID,
    },
  };
};

export const withReviewSessionMarker = (
  metadata: SessionMetadataRecord,
  originalSessionID: string,
): SessionMetadataRecord => {
  const current = getZedCodeMetadata(metadata);
  return {
    ...metadata,
    zedcode: {
      ...current,
      kind: 'review' as const,
      originalSessionID,
    },
  };
};

export const withoutReviewSessionLink = (
  metadata: SessionMetadataRecord,
  reviewSessionID: string,
): SessionMetadataRecord => {
  const current = getZedCodeMetadata(metadata);
  if (current.reviewSessionID !== reviewSessionID) return metadata;

  const restZedCode = { ...current };
  delete restZedCode.reviewSessionID;
  const next: SessionMetadataRecord = { ...metadata };
  if (Object.keys(restZedCode).length > 0) {
    next.zedcode = restZedCode;
  } else {
    delete next.zedcode;
  }
  return next;
};
