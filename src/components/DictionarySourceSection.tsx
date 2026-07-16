import { ExternalLinkIcon } from 'lucide-react'

import type { DictionarySourceState } from '../dictionary/coordinator'
import type { DictionaryText } from '../dictionary/types'
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
        <div className="space-y-6 px-5 py-4">
          {source.result.content.entries.map((entry, entryIndex) => (
            <article
              key={`${entry.pronunciation ?? entry.headword ?? ''}-${entryIndex}`}
              className="space-y-3"
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
              <ol className="space-y-3">
                {entry.senses.map((sense, senseIndex) => (
                  <li
                    key={`${sense.marker ?? 'plain'}-${senseIndex}`}
                    className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2"
                  >
                    {sense.marker ? (
                      <span
                        data-dictionary-sense-marker="true"
                        className="text-right font-medium text-[var(--flow-accent)]"
                      >
                        {sense.marker}
                      </span>
                    ) : (
                      <span aria-hidden="true" />
                    )}
                    <div className="min-w-0 space-y-1.5 leading-relaxed">
                      <div>
                        <DictionaryTextView text={sense.definition} />
                      </div>
                      {sense.examples?.map((example, exampleIndex) => (
                        <div
                          key={exampleIndex}
                          className="text-muted-foreground text-sm leading-relaxed"
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
                ))}
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
          className={
            run.kind === 'emphasis'
              ? 'font-medium'
              : run.kind === 'label'
                ? 'text-muted-foreground'
                : undefined
          }
        >
          {run.text}
        </span>
      ))}
    </>
  )
}
