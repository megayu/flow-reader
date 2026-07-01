export function formatErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error

  try {
    const json = JSON.stringify(error)
    if (json) return json
  } catch {}

  return String(error)
}
