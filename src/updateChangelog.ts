const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\](?: - (\d{4}-\d{2}-\d{2}))?[ \t]*$/gm

export interface ChangelogSection {
  body: string
  date?: string
  markdown: string
  version: string
}

export function parseChangelog(markdown: string): ChangelogSection[] {
  const matches = [...markdown.matchAll(VERSION_HEADING)]
  const versions = new Set<string>()

  return matches.map((match, index) => {
    const version = match[1]
    if (!version) throw new Error('A changelog version heading is missing its version.')
    if (versions.has(version)) throw new Error(`Duplicate changelog version ${version}.`)
    versions.add(version)

    const start = match.index
    const end = matches[index + 1]?.index ?? markdown.length
    const sectionMarkdown = markdown.slice(start, end).trim()
    const headingEnd = sectionMarkdown.indexOf('\n')

    return {
      version,
      ...(match[2] ? { date: match[2] } : {}),
      markdown: sectionMarkdown,
      body: headingEnd === -1 ? '' : sectionMarkdown.slice(headingEnd + 1).trim(),
    }
  })
}

export function changelogSectionForVersion(markdown: string, version: string) {
  const section = parseChangelog(markdown).find((candidate) => candidate.version === version)
  if (!section) throw new Error(`CHANGELOG.md does not contain version ${version}.`)
  return section
}

export function changelogSectionsBetween(markdown: string, currentVersion: string, latestVersion: string) {
  const sections = parseChangelog(markdown)
  const latestIndex = sections.findIndex((section) => section.version === latestVersion)
  const currentIndex = sections.findIndex((section) => section.version === currentVersion)
  if (latestIndex === -1) throw new Error(`CHANGELOG.md does not contain version ${latestVersion}.`)
  if (currentIndex === -1) throw new Error(`CHANGELOG.md does not contain version ${currentVersion}.`)
  if (latestIndex >= currentIndex) {
    throw new Error(`CHANGELOG.md does not place ${latestVersion} before ${currentVersion}.`)
  }
  return sections.slice(latestIndex, currentIndex)
}
