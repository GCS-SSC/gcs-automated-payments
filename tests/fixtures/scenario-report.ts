import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type ScenarioReportRow = Record<string, string | number | boolean | undefined>

/** Emits optional review artifacts only when explicitly requested by the test runner. */
export const writeScenarioCsvReport = async (fileName: string, rows: ScenarioReportRow[]) => {
  const directory = process.env.AUTOMATED_PAYMENTS_SCENARIO_CSV_DIR ?? process.env.GCS_PAYMENT_AUDIT_DIR
  if (!directory || rows.length === 0) return
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))]
  const cell = (value: string | number | boolean | undefined) => `"${String(value ?? '').replaceAll('"', '""')}"`
  const csv = [columns.map(cell).join(','), ...rows.map(row => columns.map(column => cell(row[column])).join(','))].join('\n') + '\n'
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, fileName), csv, 'utf8')
}
