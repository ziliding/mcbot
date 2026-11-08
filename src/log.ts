/** Structured JSON-lines logging to stdout (docker logs). */
export function log (event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }))
}
