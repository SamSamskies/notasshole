export type GeminiQuotaKind = 'daily' | 'rate'

/**
 * Daily RPD vs short-window RPM/TPM/concurrency.
 * Unknown 429s are treated as rate — that is the usual free-tier hit.
 * Duplicated in api/judge.ts because Vercel does not bundle this file into the function.
 */
export function classifyGemini429(body: unknown): GeminiQuotaKind {
  const text = collectStrings(body).join(' ')
  if (/PerDay|per_day|per day|RequestsPerDay|_rpd\b/i.test(text)) return 'daily'
  return 'rate'
}

export function collectQuotaIds(value: unknown): string[] {
  const ids: string[] = []
  walkObjects(value, (record) => {
    if (typeof record.quotaId === 'string' && record.quotaId.trim()) {
      ids.push(record.quotaId)
    }
  })
  return ids
}

function collectStrings(value: unknown): string[] {
  const parts: string[] = []
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node && typeof node === 'object') {
      for (const child of Object.values(node as Record<string, unknown>)) {
        visit(child)
      }
    }
  }
  visit(value)
  return parts
}

function walkObjects(
  value: unknown,
  visit: (record: Record<string, unknown>) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit)
    return
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    visit(record)
    for (const child of Object.values(record)) walkObjects(child, visit)
  }
}
