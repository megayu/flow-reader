import { useCallback, useEffect, useRef, useState } from 'react'

import type { DictionaryQueryLanguage } from '../dictionary/types'

interface UseSelectionSpeechOptions {
  bookLanguage?: string
  queryLanguage: DictionaryQueryLanguage
  text: string
}

function normalizeLocale(locale?: string) {
  return locale?.trim().replaceAll('_', '-').toLowerCase()
}

function primaryLanguage(locale?: string) {
  return normalizeLocale(locale)?.split('-')[0]
}

function queryFallbackLocale(language: DictionaryQueryLanguage) {
  if (language === 'zh') return 'zh-CN'
  if (language === 'en') return 'en-US'
}

function selectVoice(
  voices: readonly SpeechSynthesisVoice[],
  queryLanguage: DictionaryQueryLanguage,
  bookLanguage?: string,
) {
  const queryPrimary =
    queryLanguage === 'zh' || queryLanguage === 'en' ? queryLanguage : undefined
  const bookLocale = normalizeLocale(bookLanguage)
  const bookPrimary = primaryLanguage(bookLanguage)
  const preferredPrimary = queryPrimary ?? bookPrimary
  const preferredLocale =
    bookLocale && (!queryPrimary || bookPrimary === queryPrimary)
      ? bookLocale
      : normalizeLocale(queryFallbackLocale(queryLanguage))

  return (
    voices.find((voice) => normalizeLocale(voice.lang) === preferredLocale) ??
    voices.find((voice) => primaryLanguage(voice.lang) === preferredPrimary) ??
    voices.find((voice) => voice.default) ??
    voices[0]
  )
}

export function useSelectionSpeech({
  bookLanguage,
  queryLanguage,
  text,
}: UseSelectionSpeechOptions) {
  const [isSupported, setIsSupported] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)

  useEffect(() => {
    setIsSupported(
      typeof window !== 'undefined' &&
        Boolean(window.speechSynthesis) &&
        typeof window.SpeechSynthesisUtterance === 'function',
    )
  }, [])

  const stop = useCallback(() => {
    const utterance = utteranceRef.current
    if (!utterance) return

    utteranceRef.current = null
    utterance.onend = null
    utterance.onerror = null
    window.speechSynthesis.cancel()
    setIsSpeaking(false)
  }, [])

  useEffect(() => stop, [stop])

  const speak = useCallback(() => {
    if (!isSupported || !text.trim()) return
    if (utteranceRef.current) {
      stop()
      return
    }

    const synthesis = window.speechSynthesis
    synthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    const voice = selectVoice(
      synthesis.getVoices(),
      queryLanguage,
      bookLanguage,
    )
    const fallbackLocale =
      bookLanguage &&
      (!primaryLanguage(queryFallbackLocale(queryLanguage)) ||
        primaryLanguage(bookLanguage) ===
          primaryLanguage(queryFallbackLocale(queryLanguage)))
        ? bookLanguage
        : queryFallbackLocale(queryLanguage)

    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang ?? fallbackLocale ?? ''

    const finish = () => {
      if (utteranceRef.current !== utterance) return
      utteranceRef.current = null
      setIsSpeaking(false)
    }
    utterance.onend = finish
    utterance.onerror = finish
    utteranceRef.current = utterance
    setIsSpeaking(true)
    try {
      synthesis.speak(utterance)
    } catch {
      finish()
    }
  }, [bookLanguage, isSupported, queryLanguage, stop, text])

  return {
    isSpeaking,
    isSupported,
    toggle: speak,
  }
}
