/**
 * Bridge to the uVision command line (UV4.exe).  Used as a high-fidelity
 * fallback for builds and as the default download/flash backend, because the
 * flash algorithms and debugger DLLs live inside uVision.
 *
 *   UV4.exe -b project.uvprojx -t "Target 1" -j0 -o build.log
 *   UV4.exe -r ...   rebuild
 *   UV4.exe -c ...   clean
 *   UV4.exe -f ...   download to flash
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DiagnosticEntry, ParseResult, parseOutput } from './diagnostics';

export type UV4Action = 'build' | 'rebuild' | 'clean' | 'flash';

export interface UV4RunOptions {
  uv4Path: string;
  projectFile: string;
  action: UV4Action;
  target?: string;
  token?: { isCancellationRequested: boolean };
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface UV4RunResult {
  exitCode: number;
  output: string;
  parsed: ParseResult;
  timedOut: boolean;
  logFile: string;
}

const ACTION_SWITCH: Record<UV4Action, string> = {
  build: '-b',
  rebuild: '-r',
  clean: '-c',
  flash: '-f',
};

export function uv4ExitDescription(code: number): string {
  switch (code) {
    case 0:
      return 'no errors or warnings';
    case 1:
      return 'completed with warnings';
    case 2:
      return 'completed with errors';
    case 3:
      return 'fatal build error';
    case 11:
      return 'project could not be opened';
    case 12:
      return 'selected device has no matching toolchain';
    case 13:
      return 'error writing to a file';
    case 15:
      return 'error reading a file';
    case 20:
      return 'license error';
    case 41:
      return 'invalid command line';
    default:
      return `uVision exit code ${code}`;
  }
}

export function runUV4(options: UV4RunOptions): Promise<UV4RunResult> {
  const logFile = path.join(
    os.tmpdir(),
    `keil-uv4-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`
  );
  const args: string[] = [ACTION_SWITCH[options.action], options.projectFile];
  if (options.target) {
    args.push('-t', options.target);
  }
  args.push('-j0', '-o', logFile);

  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;
    let settled = false;
    const started = Date.now();
    let pollTimer: NodeJS.Timeout | undefined;

    const finish = (code: number): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      let output = '';
      try {
        output = fs.readFileSync(logFile, 'utf8');
      } catch {
        output = stdout;
      }
      if (stdout && !output.includes(stdout.trim().slice(0, 40)) && stdout.trim()) {
        output += `\n${stdout}`;
      }
      const parsed = parseOutput(output, { projectDir: path.dirname(options.projectFile) });
      try {
        fs.unlinkSync(logFile);
      } catch {
        // ignore
      }
      resolve({ exitCode: code, output, parsed, timedOut, logFile });
    };

    let child;
    try {
      child = spawn(options.uv4Path, args, {
        cwd: path.dirname(options.projectFile),
        windowsHide: true,
        env: process.env,
      });
    } catch (error) {
      resolve({
        exitCode: -1,
        output: `Failed to start UV4.exe: ${String(error)}`,
        parsed: { diagnostics: [], errors: 1, warnings: 0 },
        timedOut: false,
        logFile,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      options.log?.(`uVision did not finish within ${Math.round(timeoutMs / 1000)}s - terminated.`);
      finish(-1);
    }, timeoutMs);

    pollTimer = setInterval(() => {
      if (options.token?.isCancellationRequested) {
        clearInterval(pollTimer);
        try {
          child.kill();
        } catch {
          // ignore
        }
        finish(-1);
      }
    }, 250);

    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('error', (error) => {
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      stdout += `\nFailed to start UV4.exe: ${error.message}\n`;
      finish(-1);
    });
    child.on('close', (code) => {
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      if (!settled) {
        options.log?.(`uVision finished in ${((Date.now() - started) / 1000).toFixed(1)}s (${uv4ExitDescription(code ?? -1)})`);
      }
      finish(code ?? -1);
    });
  });
}

export interface FlashResult {
  success: boolean;
  message: string;
  diagnostics: DiagnosticEntry[];
  output: string;
}

const FLASH_SUCCESS_MARKERS = [
  /Verify OK/i,
  /Programming Done/i,
  /Application running/i,
  /Flash Load finished/i,
];

const FLASH_ERROR_MARKERS = [
  /Error:\s*Flash Download failed/i,
  /No ULINK Device found/i,
  /No ST-LINK detected/i,
  /No J-Link found/i,
  /Cannot Load Flash Programming Algorithm/i,
  /Could not find an Cortex-M/i,
  /Flash Download failed/i,
];

export function interpretFlashResult(result: UV4RunResult): FlashResult {
  const output = result.output;
  const failed = FLASH_ERROR_MARKERS.some((marker) => marker.test(output));
  const succeeded = FLASH_SUCCESS_MARKERS.some((marker) => marker.test(output));
  const diagnostics = result.parsed.diagnostics;
  if (result.exitCode === 0 && !failed && (succeeded || !output.trim())) {
    return {
      success: true,
      message: succeeded ? 'Download to flash completed and verified.' : 'Download to flash completed.',
      diagnostics,
      output,
    };
  }
  const errorLine =
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /error|failed|not found|no .*device/i.test(line)) ?? '';
  return {
    success: false,
    message:
      errorLine ||
      `Download failed (${uv4ExitDescription(result.exitCode)})${result.timedOut ? ' - timed out' : ''}.`,
    diagnostics,
    output,
  };
}

/** Check whether the configured uVision has a usable command line. */
export function isUvisionAvailable(uv4Path: string): boolean {
  try {
    return fs.statSync(uv4Path).isFile();
  } catch {
    return false;
  }
}
