import { applicationBuildVersion, applicationCopyright, sourceRepositoryUrl } from '@/build'
import { Button } from '@/components/ui/button'
import { openSupportedExternalUrl } from '@/externalLink'
import { useTranslation } from '@/hooks/useTranslation'
import { UpdaterControl } from '@/updater-entry'

import appIconUrl from '../../src-tauri/icons/128x128.png'

export function AboutSettings() {
  const t = useTranslation()

  return (
    <div className="space-y-3">
      <div className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)_auto] grid-rows-[20px_20px_20px] items-center gap-x-3">
        <img src={appIconUrl} alt="" className="row-span-3 size-16" />
        <h3 className="font-semibold text-base leading-5 text-(--flow-text)">Flow Reader</h3>
        <div className="row-span-2 self-center">
          <UpdaterControl />
        </div>
        <p className="col-start-2 font-mono text-sm leading-5 text-muted-foreground" style={{ paddingBlock: 0 }}>
          {t('settings.about.version', applicationBuildVersion)}
        </p>
        <p className="col-span-2 col-start-2 text-sm leading-5 text-muted-foreground" style={{ paddingBlock: 0 }}>
          {applicationCopyright}
        </p>
      </div>

      <div className="border-border border-t pt-3 text-sm leading-5 text-muted-foreground">
        <p style={{ paddingBlock: 0 }}>
          <span className="block">
            Flow Reader is based on Flow by pacexy and is licensed under the GNU Affero General Public License v3.0.
          </span>
          <span className="block">
            Flow Reader includes code derived from Epub.js, Copyright © 2013 FuturePress, licensed under the BSD
            2-Clause License.
          </span>
        </p>
        {sourceRepositoryUrl && (
          <p className="mt-1" style={{ paddingBlock: 0 }}>
            Source code is available on{' '}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 align-baseline text-sm"
              onClick={() => {
                void openSupportedExternalUrl(sourceRepositoryUrl).catch(() => undefined)
              }}
            >
              GitHub
            </Button>
            .
          </p>
        )}
      </div>
    </div>
  )
}
