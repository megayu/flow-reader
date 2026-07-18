import { useCallback, useEffect, useRef, useState } from 'react'

import { normalizeDictionaryLanguage } from '../dictionary/query'
import type {
  DictionaryQueryLanguage,
  SupportedDictionaryLanguage,
} from '../dictionary/types'

interface UseSelectionSpeechOptions {
  queryLanguage: DictionaryQueryLanguage
  text: string
}

function normalizeLocale(locale?: string) {
  return locale?.trim().replaceAll('_', '-').toLowerCase()
}

function selectVoice(
  voices: readonly SpeechSynthesisVoice[],
  queryLanguage: DictionaryQueryLanguage,
) {
  if (queryLanguage === 'mixed' || queryLanguage === 'unknown') return
  const matching = voices.filter(
    (voice) => speechLanguage(voice.lang) === queryLanguage,
  )
  return matching.find((voice) => voice.default) ?? matching[0]
}

export function useSelectionSpeech({
  queryLanguage,
  text,
}: UseSelectionSpeechOptions) {
  const [voices, setVoices] = useState<readonly SpeechSynthesisVoice[]>([])
  const [isSpeaking, setIsSpeaking] = useState(false)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !window.speechSynthesis ||
      typeof window.SpeechSynthesisUtterance !== 'function'
    ) {
      setVoices([])
      return
    }

    const synthesis = window.speechSynthesis
    const refreshVoices = () => setVoices([...synthesis.getVoices()])
    refreshVoices()
    synthesis.addEventListener('voiceschanged', refreshVoices)
    return () => synthesis.removeEventListener('voiceschanged', refreshVoices)
  }, [])

  const voice = selectVoice(voices, queryLanguage)
  const isSupported = Boolean(voice)

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
    const currentVoice = selectVoice(synthesis.getVoices(), queryLanguage)
    if (!currentVoice) return
    utterance.voice = currentVoice
    utterance.lang = currentVoice.lang

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
  }, [isSupported, queryLanguage, stop, text])

  return {
    isSpeaking,
    isSupported,
    toggle: speak,
  }
}

function speechLanguage(
  locale: string,
): SupportedDictionaryLanguage | undefined {
  const normalized = normalizeLocale(locale)
  if (!normalized) return
  return normalizeDictionaryLanguage(normalized.split('-')[0])
}
