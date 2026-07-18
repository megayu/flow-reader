export function parseGoogleTranslationResponse(body: string): string[] {
  try {
    const response: unknown = JSON.parse(body)
    if (!Array.isArray(response) || !Array.isArray(response[0]))
      throw new Error()

    const translated = response[0]
      .map((segment) => (Array.isArray(segment) ? segment[0] : undefined))
      .filter((segment): segment is string => typeof segment === 'string')
      .join('')

    if (!translated) throw new Error()
    return [translated]
  } catch {
    throw new Error('Invalid Google translation response')
  }
}

export function parseGoogleTranslationResponses(bodies: string[]): string[] {
  return bodies.flatMap(parseGoogleTranslationResponse)
}
