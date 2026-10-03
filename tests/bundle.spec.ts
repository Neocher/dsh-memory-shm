// The bundle layer the host applies is part of this package's contract: these
// cases fail if the patch stops naming this package, stops carrying a loadable
// configuration, or drifts from the plugin's own config schema.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

/** The parsed package manifest. */
const manifest = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  name: string
  dsh?: { bundle?: { patch?: string } }
}

/** The patch file the manifest points at. */
const patchPath = manifest.dsh?.bundle?.patch

describe('bundle layer', () => {
  it('declares the patch the host applies', () => {
    expect(patchPath).toBe('./cordis.patch.yml')
    expect(() => readFileSync(`${root}${patchPath?.slice(2)}`, 'utf8')).not.toThrow()
  })

  it('inserts this package under a loadable configuration', () => {
    const patch = parse(readFileSync(`${root}cordis.patch.yml`, 'utf8')) as
      Array<{ insert?: Array<{ id?: string; name?: string; config?: unknown }> }>
    const rows = patch.flatMap(entry => entry.insert ?? [])
    const row = rows.find(candidate => candidate.name === manifest.name)

    expect(row, `patch must insert ${manifest.name}`).toBeDefined()
    expect(row?.id).toBe('memory-shm')
    // Load-time validation: a patch whose config the schema rejects would leave
    // the plugin pending on every profile that installs this bundle.
    expect(Config(row?.config as never)).toMatchObject({ writeEnabled: false, recall: { enabled: false } })
  })
})
