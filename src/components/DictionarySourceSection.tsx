import { ExternalLinkIcon } from 'lucide-react'

import type { DictionarySourceState } from '../dictionary/coordinator'
import type {
  DictionarySense,
  DictionarySenseMarkerParts,
  DictionaryText,
} from '../dictionary/types'
import { openSupportedExternalUrl } from '../externalLink'
import { useTranslation } from '../hooks/useTranslation'

interface DictionarySourceSectionProps {
  source: DictionarySourceState
}

export function DictionarySourceSection({
  source,
}: DictionarySourceSectionProps) {
  const t = useTranslation('dictionary')
  const externalUrl = source.result?.externalUrl ?? source.externalUrl

  return (
    <section aria-labelledby={`dictionary-source-${source.providerId}`}>
      <div className="border-border flex min-h-10 items-center border-b px-5">
        <h2
          id={`dictionary-source-${source.providerId}`}
          className="text-muted-foreground text-sm font-medium"
        >
          {source.providerName}
        </h2>
        {externalUrl && source.status !== 'loading' && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground ml-auto inline-flex cursor-pointer items-center gap-1 rounded-sm px-1 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--flow-accent-border)]"
            aria-label={
              source.providerId === 'zdic'
                ? t('view_on_zdic')
                : source.providerId === 'merriam-webster'
                  ? t('view_on_merriam_webster')
                  : t('view_source')
            }
            onClick={() => {
              void openSupportedExternalUrl(externalUrl).catch(() => undefined)
            }}
          >
            <span>{t('view_source')}</span>
            <ExternalLinkIcon className="size-3.5" />
          </button>
        )}
      </div>

      {source.status === 'loading' ? (
        <div
          role="status"
          aria-label={t('loading')}
          className="min-h-32 space-y-3 px-5 py-4"
        >
          <div className="bg-muted h-5 w-28 animate-pulse rounded" />
          <div className="bg-muted h-4 w-11/12 animate-pulse rounded" />
          <div className="bg-muted h-4 w-4/5 animate-pulse rounded" />
        </div>
      ) : source.status === 'error' ? (
        <div className="text-muted-foreground min-h-24 px-5 py-4 text-sm">
          {source.error === 'Could not parse this entry.'
            ? t('parse_error')
            : t('lookup_error')}
        </div>
      ) : source.status === 'empty' ? (
        <div className="text-muted-foreground min-h-24 px-5 py-4 text-sm">
          {t('no_result')}
        </div>
      ) : source.result?.content.kind === 'entries' ? (
        <div className="space-y-[1em] px-5 py-4">
          {source.result.content.entries.map((entry, entryIndex) => (
            <article
              key={`${entry.pronunciation ?? entry.headword ?? ''}-${entryIndex}`}
              className="space-y-[0.5em]"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {entry.headword && (
                  <h3 className="text-xl font-semibold">{entry.headword}</h3>
                )}
                {entry.pronunciation && (
                  <span className="text-base font-medium text-[var(--flow-accent)]">
                    {entry.pronunciation}
                  </span>
                )}
                {entry.partOfSpeech && (
                  <span className="text-muted-foreground text-sm italic">
                    {entry.partOfSpeech}
                  </span>
                )}
              </div>
              <ol className="space-y-[0.45em]">
                {entry.senses.map((sense, senseIndex) => {
                  const markerParts = senseMarkerParts(sense)
                  const markerDepth = senseMarkerDepth(markerParts)

                  return (
                    <li
                      key={`${sense.marker ?? 'plain'}-${senseIndex}`}
                      className={
                        markerDepth
                          ? 'grid grid-cols-[1.75em_1.4em_2.4em_minmax(0,1fr)] items-baseline leading-snug'
                          : 'leading-snug'
                      }
                      data-dictionary-marker-depth={markerDepth ?? 'none'}
                      data-dictionary-sense-level={sense.level ?? 0}
                    >
                      {markerParts?.number && (
                        <SenseMarker kind="number">
                          {markerParts.number}
                        </SenseMarker>
                      )}
                      {markerParts?.letter && (
                        <SenseMarker kind="letter">
                          {markerParts.letter}
                        </SenseMarker>
                      )}
                      {markerParts?.subnumber && (
                        <SenseMarker kind="subnumber">
                          {markerParts.subnumber}
                        </SenseMarker>
                      )}
                      <div
                        className={`${senseContentColumn(markerDepth)} min-w-0 space-y-[0.25em]`}
                        data-dictionary-sense-content="true"
                      >
                        <div>
                          <DictionaryTextView text={sense.definition} />
                        </div>
                        {sense.examples?.map((example, exampleIndex) => (
                          <div
                            key={exampleIndex}
                            className="text-muted-foreground text-sm leading-snug"
                          >
                            <span className="bg-muted mr-2 inline-flex rounded px-1.5 py-0.5 text-xs font-medium">
                              {t('example')}
                            </span>
                            <span>
                              <DictionaryTextView text={example} />
                            </span>
                          </div>
                        ))}
                      </div>
                    </li>
                  )
                })}
              </ol>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function DictionaryTextView({ text }: { text: DictionaryText }) {
  if (text.kind === 'plain') return <>{text.text}</>

  return (
    <>
      {text.runs.map((run, index) => (
        <span
          key={index}
          data-dictionary-text-kind={run.kind}
          className={
            run.kind === 'emphasis'
              ? 'italic'
              : run.kind === 'label'
                ? 'text-muted-foreground italic'
                : undefined
          }
        >
          {run.text}
        </span>
      ))}
    </>
  )
}

type SenseMarkerKind = keyof DictionarySenseMarkerParts

function SenseMarker({
  children,
  kind,
}: {
  children: string
  kind: SenseMarkerKind
}) {
  const column =
    kind === 'number'
      ? 'col-start-1'
      : kind === 'letter'
        ? 'col-start-2'
        : 'col-start-3'
  const appearance =
    kind === 'number'
      ? 'font-semibold tabular-nums text-foreground'
      : kind === 'subnumber'
        ? 'font-medium tabular-nums text-muted-foreground'
        : 'font-medium text-muted-foreground'

  return (
    <span
      className={`${column} ${appearance} justify-self-start whitespace-nowrap`}
      data-dictionary-sense-marker={kind}
    >
      {children}
    </span>
  )
}

function senseMarkerParts(
  sense: DictionarySense,
): DictionarySenseMarkerParts | undefined {
  if (sense.markerParts) return sense.markerParts
  return sense.marker ? { number: sense.marker } : undefined
}

function senseMarkerDepth(parts?: DictionarySenseMarkerParts) {
  if (parts?.subnumber) return 'subnumber'
  if (parts?.letter) return 'letter'
  if (parts?.number) return 'number'
}

function senseContentColumn(depth: ReturnType<typeof senseMarkerDepth>) {
  if (depth === 'subnumber') return 'col-start-4 col-end-5'
  if (depth === 'letter') return 'col-start-3 col-end-5'
  if (depth === 'number') return 'col-start-2 col-end-5'
  return ''
}
