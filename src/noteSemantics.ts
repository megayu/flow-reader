const NOTE_CIRCLED_MARKER_PATTERN = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/
const NOTE_NUMBER_MARKER_CHARS = '0-9零〇一二三四五六七八九十壹贰貳叁參肆伍陆陸柒捌玖拾佰仟百千萬万億亿兩两廿卅卌'
const NOTE_NUMBER_MARKER_PATTERN = new RegExp(`^[${NOTE_NUMBER_MARKER_CHARS}]+$`)
const NOTE_MARKER_OPENERS = '([〔［（【〚〖'
const NOTE_MARKER_CLOSERS = ')]〕］）】〛〗'

export function isNoteMarkerText(text: string | null | undefined) {
  const marker = (text ?? '').trim()
  if (!marker) return false
  if (/^[*＊]+$/.test(marker)) return true
  if (NOTE_CIRCLED_MARKER_PATTERN.test(marker)) return true

  const normalized = stripNoteMarkerWrapper(marker)
  return NOTE_NUMBER_MARKER_PATTERN.test(normalized)
}

function stripNoteMarkerWrapper(text: string) {
  let marker = text.trim()

  if (NOTE_MARKER_OPENERS.includes(marker[0] ?? '')) {
    marker = marker.slice(1)
  }
  if (NOTE_MARKER_CLOSERS.includes(marker[marker.length - 1] ?? '')) {
    marker = marker.slice(0, -1)
  }

  return marker.trim()
}
