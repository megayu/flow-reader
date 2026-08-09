import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { useTranslation } from '../hooks/useTranslation'
import {
  orderedSourceLanguages,
  orderedTargetLanguages,
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
  type TranslationProvider,
  type TranslationSourceLanguage,
} from '../translation/languages'
import { splitTranslationSections } from '../translation/serialize'
import { translateTexts } from '../translation/translate'
import { clamp, copy } from '../utils'

import { IconButton } from './IconButton'
import { Button } from './ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

const SPLITTER_SIZE = 6
const PANEL_PADDING_Y = 16
const MIN_SOURCE_HEIGHT = 36
const MIN_RESULT_HEIGHT = 40

const languageLabels = new Map(TRANSLATION_LANGUAGES.map(({ id, label }) => [id, label]))

interface TranslationPopupProps {
  text: string
  mainLanguage: TranslationLanguage
  secondaryLanguage: TranslationLanguage
  initialProvider: TranslationProvider
  initialSourceLanguage: TranslationSourceLanguage
  initialTargetLanguage: TranslationLanguage
  maxPopupHeight: number
  onBack: () => void
  onClose: () => void
}

export function TranslationPopup({
  text,
  mainLanguage,
  secondaryLanguage,
  initialProvider,
  initialSourceLanguage,
  initialTargetLanguage,
  maxPopupHeight,
  onBack,
  onClose,
}: TranslationPopupProps) {
  const t = useTranslation('translation')
  const [provider, setProvider] = useState(initialProvider)
  const [sourceLanguage, setSourceLanguage] = useState(initialSourceLanguage)
  const [targetLanguage, setTargetLanguage] = useState(initialTargetLanguage)
  const [translated, setTranslated] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const [bodyHeight, setBodyHeight] = useState<number>()
  const [sourceHeight, setSourceHeight] = useState<number>()
  const sourceContentRef = useRef<HTMLDivElement>(null)
  const resultContentRef = useRef<HTMLDivElement>(null)
  const requestGenerationRef = useRef(0)
  const maxBodyHeight = Math.max(0, maxPopupHeight - 40)

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++requestGenerationRef.current
    setError('')
    setTranslated('')
    void translateTexts({
      provider,
      texts: splitTranslationSections(text),
      sourceLanguage,
      targetLanguage,
      signal: controller.signal,
    })
      .then((results) => {
        if (controller.signal.aborted || generation !== requestGenerationRef.current) return
        setTranslated(results.join('\n\n'))
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted && generation === requestGenerationRef.current) {
          setError(error.message)
        }
      })
    return () => {
      controller.abort()
      if (generation === requestGenerationRef.current) requestGenerationRef.current++
    }
  }, [provider, retryCount, sourceLanguage, targetLanguage, text])

  useLayoutEffect(() => {
    const source = sourceContentRef.current
    const result = resultContentRef.current
    if (!source || !result) return

    const naturalSourceHeight = source.scrollHeight + PANEL_PADDING_Y
    const naturalResultHeight = result.scrollHeight + PANEL_PADDING_Y
    const nextBodyHeight = Math.min(
      maxBodyHeight,
      Math.max(
        MIN_SOURCE_HEIGHT + MIN_RESULT_HEIGHT + SPLITTER_SIZE,
        naturalSourceHeight + naturalResultHeight + SPLITTER_SIZE,
      ),
    )
    const available = nextBodyHeight - SPLITTER_SIZE
    const resultHeight = Math.min(naturalResultHeight, available - MIN_SOURCE_HEIGHT)
    const nextSourceHeight = clamp(available - resultHeight, MIN_SOURCE_HEIGHT, available - MIN_RESULT_HEIGHT)
    setBodyHeight(nextBodyHeight)
    setSourceHeight(nextSourceHeight)
  }, [error, maxBodyHeight, text, translated])

  const copyText = translated || error
  const languageSelect = (
    value: TranslationSourceLanguage,
    values: TranslationSourceLanguage[],
    onChange: (value: string) => void,
  ) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 rounded-sm px-2 text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {values.map((language) => (
          <SelectItem key={language} value={language}>
            {language === 'auto' ? t('auto_detect') : (languageLabels.get(language) ?? language)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <div className="bg-popover w-full">
      <div data-flow-translation-toolbar className="border-border flex h-10 items-center gap-1 border-b px-1.5">
        <IconButton Icon={ArrowLeftIcon} className="shrink-0" onClick={onBack} />
        {languageSelect(sourceLanguage, orderedSourceLanguages(mainLanguage, secondaryLanguage), (value) =>
          setSourceLanguage(value as TranslationSourceLanguage),
        )}
        <ArrowRightIcon className="text-muted-foreground size-4 shrink-0" />
        {languageSelect(targetLanguage, orderedTargetLanguages(mainLanguage, secondaryLanguage), (value) =>
          setTargetLanguage(value as TranslationLanguage),
        )}
        <div className="ring-border flex h-7 shrink-0 items-center rounded-sm p-0.5 ring-1 ring-inset">
          {(['google', 'azure'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              variant={provider === value ? 'secondary' : 'ghost'}
              size="sm"
              className="h-6 rounded-sm px-1.5 text-xs"
              onClick={() => setProvider(value)}
            >
              {value === 'google' ? 'Google' : 'Azure'}
            </Button>
          ))}
        </div>
        <IconButton
          Icon={copied ? CheckIcon : CopyIcon}
          className="shrink-0"
          disabled={!copyText}
          onClick={() => {
            if (!copyText) return
            copy(copyText)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          }}
        />
        <IconButton Icon={XIcon} className="shrink-0" onClick={onClose} />
      </div>
      <div className="min-h-0" data-flow-translation-split style={{ height: bodyHeight, maxHeight: maxBodyHeight }}>
        <div
          className="text-muted-foreground scroll overflow-y-auto px-3 py-2 text-sm leading-5 whitespace-pre-wrap"
          data-flow-translation-source
          style={{ height: sourceHeight }}
        >
          <div ref={sourceContentRef}>{text}</div>
        </div>
        <div
          className="group relative z-10 h-1.5 cursor-ns-resize touch-none"
          data-flow-translation-splitter
          onPointerDown={(event) => {
            if (bodyHeight === undefined || sourceHeight === undefined) return
            event.preventDefault()
            const pointerId = event.pointerId
            const splitter = event.currentTarget
            const startY = event.clientY
            const startHeight = sourceHeight
            const available = bodyHeight - SPLITTER_SIZE
            splitter.setPointerCapture(pointerId)
            const onPointerMove = (moveEvent: PointerEvent) => {
              if (moveEvent.pointerId !== pointerId) return
              setSourceHeight(
                clamp(startHeight + moveEvent.clientY - startY, MIN_SOURCE_HEIGHT, available - MIN_RESULT_HEIGHT),
              )
            }
            const onPointerUp = (upEvent: PointerEvent) => {
              if (upEvent.pointerId !== pointerId) return
              splitter.removeEventListener('pointermove', onPointerMove)
              splitter.removeEventListener('pointerup', onPointerUp)
              splitter.removeEventListener('pointercancel', onPointerUp)
            }
            splitter.addEventListener('pointermove', onPointerMove)
            splitter.addEventListener('pointerup', onPointerUp)
            splitter.addEventListener('pointercancel', onPointerUp)
          }}
        >
          <div className="bg-border absolute inset-x-0 top-1/2 h-px -translate-y-1/2 transition-colors group-hover:bg-(--flow-accent)" />
        </div>
        <div
          className="scroll overflow-y-auto px-3 py-2 text-base leading-6 whitespace-pre-wrap"
          data-flow-translation-result
          style={{
            height:
              bodyHeight !== undefined && sourceHeight !== undefined
                ? bodyHeight - sourceHeight - SPLITTER_SIZE
                : undefined,
          }}
        >
          <div ref={resultContentRef}>
            {!translated && !error && (
              <div className="text-muted-foreground flex min-h-8 items-center justify-center">
                <LoaderCircleIcon className="size-4 animate-spin" />
              </div>
            )}
            {error && (
              <div className="text-destructive inline-flex items-center gap-1">
                <span>{error}</span>
                <IconButton
                  Icon={RefreshCwIcon}
                  className="text-muted-foreground hover:text-foreground size-6 shrink-0"
                  onClick={() => setRetryCount((count) => count + 1)}
                />
              </div>
            )}
            {translated && <div>{translated}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
