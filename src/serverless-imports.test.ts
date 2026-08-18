import { describe, expect, it } from 'vitest'

const RELATIVE_FROM = /(?:from|import)\s*['"](\.\.?\/[^'"]+)['"]/g

const sources = import.meta.glob<string>(['../api/**/*.ts', '../lib/**/*.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
})

describe('Vercel serverless relative imports', () => {
  it('uses .js extensions so Node ESM can resolve the compiled output', () => {
    const files = Object.keys(sources)
    expect(files.length).toBeGreaterThan(0)

    const bad: string[] = []
    for (const [file, source] of Object.entries(sources)) {
      for (const match of source.matchAll(RELATIVE_FROM)) {
        const spec = match[1]
        if (!spec.endsWith('.js')) bad.push(`${file}: ${spec}`)
      }
    }

    expect(bad).toEqual([])
  })
})
