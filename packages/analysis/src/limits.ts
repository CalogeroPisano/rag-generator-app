/**
 * Hard limits applied while acquiring a source tree. They protect the worker
 * from oversized uploads, zip bombs and huge repositories.
 *
 * Zip bombs are handled by counting the bytes actually produced while
 * inflating (never trusting sizes declared in the archive), so no separate
 * compression-ratio limit is needed.
 */
export interface AcquisitionLimits {
  /** Maximum size of the uploaded archive, in bytes. */
  readonly maxArchiveBytes: number
  /** Maximum total uncompressed size of the extracted tree, in bytes. */
  readonly maxTotalBytes: number
  /** Maximum number of file entries (archive entries or working tree files). */
  readonly maxFiles: number
  /** Files bigger than this are kept as metadata only (excluded: too_large). */
  readonly maxFileBytes: number
}

export const defaultLimits: AcquisitionLimits = {
  maxArchiveBytes: 200 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxFiles: 50_000,
  maxFileBytes: 1024 * 1024
}
