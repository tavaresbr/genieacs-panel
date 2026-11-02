import { describe, expect, it } from 'vitest'

import release from '@/generated/release.json'
import { CATEGORY_ORDER, orderReleaseChanges } from '@/lib/release-notes'

const change = (category: string, shortHash: string) => ({ category, shortHash })

describe('ordering a release for the "what\'s new" modal', () => {
  it('puts what is new before what was fixed, and maintenance last', () => {
    const ordered = orderReleaseChanges([
      change('Maintenance', 'm1'),
      change('Fixed', 'f1'),
      change('New', 'n1'),
      change('Maintenance', 'm2'),
      change('Breaking', 'b1')
    ])
    expect(ordered.map((c) => c.category)).toEqual(['Breaking', 'New', 'Fixed', 'Maintenance', 'Maintenance'])
  })

  /** Within a category the list stays in the order the commits were made. */
  it('keeps the original order inside each category', () => {
    const ordered = orderReleaseChanges([
      change('New', 'n1'),
      change('Maintenance', 'm1'),
      change('New', 'n2'),
      change('Maintenance', 'm2'),
      change('New', 'n3')
    ])
    expect(ordered.map((c) => c.shortHash)).toEqual(['n1', 'n2', 'n3', 'm1', 'm2'])
  })

  it('sends a category it does not know to the end, not the top', () => {
    const ordered = orderReleaseChanges([change('Whatever', 'w1'), change('Maintenance', 'm1'), change('New', 'n1')])
    expect(ordered.map((c) => c.shortHash)).toEqual(['n1', 'm1', 'w1'])
  })

  it('does not reorder the list it was given', () => {
    const input = [change('Maintenance', 'm1'), change('New', 'n1')]
    orderReleaseChanges(input)
    expect(input.map((c) => c.shortHash)).toEqual(['m1', 'n1'])
  })

  /**
   * The release the panel ships: whatever it carries, the first entries the
   * modal shows are its new features, not the first maintenance commit.
   */
  it('opens the shipped release with its new features', () => {
    const ordered = orderReleaseChanges(release.changes)
    const firstNonNew = ordered.findIndex((c) => !['Breaking', 'New'].includes(c.category))
    const news = release.changes.filter((c) => ['Breaking', 'New'].includes(c.category)).length
    expect(firstNonNew === -1 ? ordered.length : firstNonNew).toBe(news)
    expect(ordered).toHaveLength(release.changes.length)
  })

  /**
   * The modal and the CHANGELOG must agree on what comes first. Rather than a
   * copy of the list, the generator itself renders one entry per category and
   * the order of its headings is read back.
   */
  it('orders categories exactly as the CHANGELOG generator does', async () => {
    const generatorUrl = new URL('../../scripts/prepare-release.mjs', import.meta.url).href
    const generator = (await import(/* @vite-ignore */ generatorUrl)) as {
      renderChangelog: (version: string, date: string, commits: unknown[], compareUrl: string | null) => string
    }
    const commits = [...CATEGORY_ORDER].reverse().map((category, i) => ({ category, title: `t${i}`, shortHash: `h${i}` }))
    const headings = generator.renderChangelog('9.9.9', '2026-01-01', commits, null)
      .split('\n')
      .filter((line) => line.startsWith('### '))
      .map((line) => line.slice(4))
    expect(headings).toEqual([...CATEGORY_ORDER])
  })
})
