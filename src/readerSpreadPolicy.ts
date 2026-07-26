import { RenditionSpread } from '@flow/epubjs/types/rendition'

export interface BookSpreadPolicyInput {
  temporaryOverride?: RenditionSpread
  perBookOverride?: RenditionSpread
  publicationSpread?: string
  applicationDefault?: RenditionSpread
}

function normalizeUserSpread(value: unknown) {
  if (value === RenditionSpread.None) return RenditionSpread.None
  if (value === RenditionSpread.Auto || value === RenditionSpread.Always) {
    return RenditionSpread.Auto
  }
}

function normalizePublicationSpread(value: unknown) {
  if (typeof value !== 'string') return

  switch (value.trim().toLowerCase()) {
    case 'none':
      return RenditionSpread.None
    case 'auto':
    case 'landscape':
    case 'both':
    case 'portrait':
      return RenditionSpread.Auto
  }
}

export function resolveBookSpreadPolicy({
  temporaryOverride,
  perBookOverride,
  publicationSpread,
  applicationDefault,
}: BookSpreadPolicyInput): RenditionSpread {
  return (
    normalizeUserSpread(temporaryOverride) ??
    normalizeUserSpread(perBookOverride) ??
    normalizePublicationSpread(publicationSpread) ??
    normalizeUserSpread(applicationDefault) ??
    RenditionSpread.Auto
  )
}
