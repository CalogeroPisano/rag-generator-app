/**
 * Key that identifies a feature across feature maps (corrections, test questions, incremental updates): case,
 * spacing and punctuation ignored.
 */
export const featureKey = (name: string): string =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
