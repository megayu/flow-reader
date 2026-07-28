export function parseAzureTranslationResponse(body: string, expectedCount: number): string[] {
  try {
    const response: unknown = JSON.parse(body)
    if (!Array.isArray(response) || response.length !== expectedCount) {
      throw new Error()
    }

    return response.map((item) => {
      if (!item || typeof item !== 'object' || !Array.isArray((item as { translations?: unknown }).translations)) {
        throw new Error()
      }
      const translation = (item as { translations: unknown[] }).translations[0]
      if (
        !translation ||
        typeof translation !== 'object' ||
        typeof (translation as { text?: unknown }).text !== 'string'
      ) {
        throw new Error()
      }
      return (translation as { text: string }).text
    })
  } catch {
    throw new Error('Invalid Azure translation response')
  }
}
