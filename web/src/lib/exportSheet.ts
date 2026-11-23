/**
 * Download a table as a .csv file that opens straight in Excel, Google Sheets or WPS.
 * Built from data already on the phone, so it costs no extra database reads.
 */
export type Cell = string | number | boolean | null | undefined | Date;

function cell(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toLocaleString('en-NG');
  const s = String(v);
  // Stop Excel treating things like "=SUM()" or "+234…" as formulas, and quote when needed.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function downloadSheet(fileName: string, headers: string[], rows: Cell[][]) {
  const lines = [headers.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))];
  // The BOM makes Excel read ₦ and accented names correctly.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.csv') ? fileName : `${fileName}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** "NDLEA CDS" → "ndlea-cds" for file names. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'cds';

export const time = (t?: { toDate?: () => Date } | null) =>
  t?.toDate ? t.toDate().toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' }) : '';

export const dateTime = (t?: { toDate?: () => Date } | null) =>
  t?.toDate ? t.toDate().toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
