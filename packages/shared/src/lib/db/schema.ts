/**
 * Extract PostgreSQL schema from DATABASE_URL's search_path option.
 * Supports formats:
 *   - ?options=-c search_path=schema
 *   - ?options=-c%20search_path=schema (URL encoded space)
 *   - ?options=-c+search_path%3Dschema (+ for space, %3D for =)
 *
 * @param url - PostgreSQL connection URL (default: process.env.DATABASE_URL)
 * @returns Schema name or 'public' if not specified
 */
export function getSchemaFromUrl(url?: string): string {
  const dbUrl = url ?? process.env.DATABASE_URL
  if (!dbUrl) return 'public'

  try {
    const parsed = new URL(dbUrl)
    const options = parsed.searchParams.get('options')
    if (!options) return 'public'

    // Decode and normalize: handle both + and %20 for spaces
    const decoded = decodeURIComponent(options.replace(/\+/g, ' '))

    // Match -c search_path=schema (capture schema name after search_path= or search_path )
    const match = decoded.match(/search_path[=\s]+([^\s,;&]+)/)
    if (match && match[1]) {
      return match[1]
    }
  } catch {
    // Malformed URL - fall back to default
  }

  return 'public'
}

/**
 * Get schema, returning undefined if it's the default 'public'.
 * Useful for MikroORM config where undefined means "use default".
 */
export function getSchemaOrUndefined(url?: string): string | undefined {
  const schema = getSchemaFromUrl(url)
  return schema === 'public' ? undefined : schema
}
