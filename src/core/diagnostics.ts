/**
 * Parsing of ARM toolchain / µVision console output into structured
 * diagnostics.  Handles the message formats of armcc (AC5), armclang (AC6),
 * armasm and armlink, as well as the lines µVision adds to its build log.
 */

import * as path from 'path';

export interface DiagnosticEntry {
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string;
}

export interface ParseResult {
  diagnostics: DiagnosticEntry[];
  errors: number;
  warnings: number;
  /** True when the output indicates that the tool could not start at all. */
  fatal?: boolean;
}

export interface ParseOptions {
  /** Base folder used to resolve relative file names. */
  projectDir: string;
}

const AC5_PATTERN =
  /^(.*?)\((\d+)(?:,\s*(\d+))?\)\s*:\s*(fatal error|error|warning|remark|note)\s*:\s*(?:#([A-Za-z]?\d+[A-Za-z0-9\-]*)\s*:\s*)?(.*)$/i;

const AC6_PATTERN =
  /^(.*?):(\d+):(\d+):\s*(fatal error|error|warning|remark|note)\s*:\s*(.*)$/i;

const ASM_PATTERN =
  /^"?(.*?)"?,\s*line\s+(\d+)\s*:\s*(fatal error|error|warning|remark)\s*:\s*(#?[A-Za-z]?\d+[A-Za-z0-9\-]*)\s*:\s*(.*)$/i;

const TOOL_PATTERN =
  /^\s*(fatal error|error|warning)\s*:\s*([A-Za-z]?\d+[A-Za-z0-9\-]*)?\s*:?\s*(.*)$/i;

// uVision sometimes prints a file or image name followed by ": error: Lxxxx:".
const UV4_FILE_PATTERN =
  /^(.*?):\s*(fatal error|error|warning)\s*:\s*(?:([A-Z][0-9A-Z]+)\s*:\s*)?(.*)$/i;

// `file.c:97: error: ...` without a column.
const UV4_LINE_PATTERN = /^(.*?):(\d+):\s*(fatal error|error|warning)\s*:\s*(.*)$/i;

const SUMMARY_PATTERN = /(\d+)\s+Error\(s\),\s*(\d+)\s+Warning\(s\)/i;

function normalizeSeverity(value: string): 'error' | 'warning' | 'info' {
  const lower = value.toLowerCase();
  if (lower.startsWith('fatal') || lower === 'error') {
    return 'error';
  }
  if (lower === 'warning') {
    return 'warning';
  }
  return 'info';
}

function cleanFile(value: string): string {
  return value.trim().replace(/^"+|"+$/g, '');
}

function resolveFile(value: string, projectDir: string): string {
  const cleaned = cleanFile(value);
  if (!cleaned) {
    return '';
  }
  if (path.isAbsolute(cleaned)) {
    return path.normalize(cleaned);
  }
  return path.resolve(projectDir, cleaned);
}

/** Remove trailing punctuation armcc likes to add to messages. */
function cleanMessage(value: string): string {
  return value.trim().replace(/\s+$/, '');
}

export function parseOutput(output: string, options: ParseOptions): ParseResult {
  const diagnostics: DiagnosticEntry[] = [];
  let errors = 0;
  let warnings = 0;
  let summaryErrors = -1;
  let summaryWarnings = -1;
  let fatal = false;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
    if (!line.trim()) {
      continue;
    }

    const summary = SUMMARY_PATTERN.exec(line);
    if (summary) {
      summaryErrors = Number.parseInt(summary[1], 10);
      summaryWarnings = Number.parseInt(summary[2], 10);
      continue;
    }

    let match = ASM_PATTERN.exec(line);
    if (match) {
      const severity = normalizeSeverity(match[3]);
      const entry: DiagnosticEntry = {
        file: resolveFile(match[1], options.projectDir),
        line: Number.parseInt(match[2], 10),
        severity,
        code: match[4],
        message: cleanMessage(match[5]),
      };
      diagnostics.push(entry);
      if (severity === 'error') {
        errors++;
      } else if (severity === 'warning') {
        warnings++;
      }
      continue;
    }

    match = AC6_PATTERN.exec(line);
    if (match) {
      const severity = normalizeSeverity(match[4]);
      diagnostics.push({
        file: resolveFile(match[1], options.projectDir),
        line: Number.parseInt(match[2], 10),
        column: Number.parseInt(match[3], 10),
        severity,
        message: cleanMessage(match[5]),
      });
      if (severity === 'error') {
        errors++;
      } else if (severity === 'warning') {
        warnings++;
      }
      continue;
    }

    match = AC5_PATTERN.exec(line);
    if (match) {
      const severity = normalizeSeverity(match[4]);
      diagnostics.push({
        file: resolveFile(match[1], options.projectDir),
        line: Number.parseInt(match[2], 10),
        column: match[3] ? Number.parseInt(match[3], 10) : undefined,
        severity,
        code: match[5],
        message: cleanMessage(match[6]),
      });
      if (severity === 'error') {
        errors++;
      } else if (severity === 'warning') {
        warnings++;
      }
      continue;
    }

    match = TOOL_PATTERN.exec(line);
    if (match) {
      const severity = normalizeSeverity(match[1]);
      // Linker / librarian messages carry no file location.
      diagnostics.push({
        severity,
        code: match[2],
        message: cleanMessage(match[3]),
      });
      if (severity === 'error') {
        errors++;
      } else if (severity === 'warning') {
        warnings++;
      }
      continue;
    }

    match = UV4_LINE_PATTERN.exec(line);
    if (match) {
      const severity = normalizeSeverity(match[3]);
      diagnostics.push({
        file: resolveFile(match[1], options.projectDir),
        line: Number.parseInt(match[2], 10),
        severity,
        message: cleanMessage(match[4]),
      });
      if (severity === 'error') {
        errors++;
      } else if (severity === 'warning') {
        warnings++;
      }
      continue;
    }

    match = UV4_FILE_PATTERN.exec(line);
    if (match) {
      const severity = normalizeSeverity(match[2]);
      diagnostics.push({
        file: resolveFile(match[1], options.projectDir),
        severity,
        code: match[3],
        message: cleanMessage(match[4]),
      });
      if (severity === 'error') {
        errors++;
      } else if (severity === 'warning') {
        warnings++;
      }
      continue;
    }

    if (/^Cannot\s+open|^Could not\s+open|command not found|is not recognized as an internal|cannot open source input file/i.test(line)) {
      fatal = true;
    }
  }

  if (summaryErrors >= 0) {
    // The tool summary is authoritative when present.
    errors = Math.max(errors, summaryErrors);
  }
  if (summaryWarnings >= 0) {
    warnings = Math.max(warnings, summaryWarnings);
  }
  return { diagnostics, errors, warnings, fatal };
}

export function hasErrors(result: ParseResult): boolean {
  return result.errors > 0;
}
