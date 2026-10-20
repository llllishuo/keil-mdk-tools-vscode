/**
 * Translation of µVision project options into ARM toolchain command lines.
 *
 * The layout follows what µVision itself generates (verified by capturing the
 * response files it passes to ArmClang/ArmLink for real projects):
 *
 *   AC6: -xc -std=c99 --target=arm-arm-none-eabi -mcpu=cortex-m3 -c -O1 ...
 *   AC5: --c99 -c --cpu Cortex-M3 -g -O0 --apcs=interwork --split_sections ...
 */

import * as fs from 'fs';
import * as path from 'path';
import { KeilInstall, PackInfo, Toolchain, devicePackInfo } from './tools';
import { UVFile, UVTarget, absoluteIncludes, dedupe } from './uvprojx';

export interface BuildContext {
  install: KeilInstall;
  target: UVTarget;
  pack?: PackInfo;
  extraDefines: string[];
  extraIncludes: string[];
}

export interface CommandSpec {
  tool: string;
  args: string[];
  cwd: string;
  label: string;
}

const AC6_WARNING_FLAGS = [
  '-Wno-packed',
  '-Wno-missing-variable-declarations',
  '-Wno-missing-prototypes',
  '-Wno-missing-noreturn',
  '-Wno-sign-conversion',
  '-Wno-nonportable-include-path',
  '-Wno-reserved-id-macro',
  '-Wno-unused-macros',
  '-Wno-documentation-unknown-command',
  '-Wno-documentation',
  '-Wno-license-management',
  '-Wno-parentheses-equality',
];

const CXX_STANDARDS: Record<number, string> = {
  1: 'c++98',
  2: 'c++03',
  3: 'c++11',
  4: 'c++14',
  5: 'c++17',
  6: 'c++2a',
};

export function splitCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  let hasToken = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken || current) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken || current) {
    tokens.push(current);
  }
  return tokens;
}

export function quoteArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function formatCommand(tool: string, args: string[]): string {
  return [quoteArg(tool), ...args.map(quoteArg)].join(' ');
}

function compilerFor(context: BuildContext): Toolchain {
  const toolchain = context.target.uAC6 ? context.install.ac6 : context.install.ac5;
  if (!toolchain) {
    throw new Error(
      `ARM Compiler ${context.target.uAC6 ? '6 (ARMCLANG)' : '5 (ARMCC)'} was not found in ${context.install.root}. ` +
        `Install the matching compiler or change the target's compiler selection in uVision.`
    );
  }
  return toolchain;
}

function cpuName(target: UVTarget): string {
  const cpu = target.device.cpuType || 'Cortex-M3';
  return cpu;
}

function ac6Cpu(target: UVTarget): string {
  return cpuName(target)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\+/g, 'plus');
}

function ac6FpuFlags(target: UVTarget): string[] {
  if (target.device.fpu === 'none') {
    return [];
  }
  const cpu = ac6Cpu(target);
  let fpu = 'fpv4-sp-d16';
  if (target.device.fpu === 'double') {
    fpu = 'fpv5-d16';
  } else if (/cortex-m7|cortex-m33|cortex-m35p|cortex-m55|cortex-m85/.test(cpu)) {
    fpu = 'fpv5-sp-d16';
  }
  return [`-mfpu=${fpu}`, '-mfloat-abi=hard'];
}

function ac5FpuFlags(target: UVTarget): string[] {
  if (target.device.fpu === 'none') {
    return [];
  }
  return [target.device.fpu === 'double' ? '--fpu=FPv5-D16' : '--fpu=FPv4-SP'];
}

export function uvisionVersionDefine(install: KeilInstall): string | undefined {
  const match = /(\d+)\.(\d+)/.exec(install.version);
  if (!match) {
    return undefined;
  }
  const value = Number.parseInt(match[1], 10) * 100 + Number.parseInt(match[2], 10);
  return `__UVISION_VERSION=${value}`;
}

export function contextDefines(context: BuildContext, file?: UVFile): string[] {
  const target = context.target;
  const defines: string[] = [];
  const versionDefine = uvisionVersionDefine(context.install);
  if (versionDefine) {
    defines.push(versionDefine);
  }
  const packInfo = devicePackInfo(context.pack, target.device.name);
  defines.push(...packInfo.defines);
  defines.push(...target.compiler.defines);
  if (file) {
    defines.push(...file.defines);
  }
  defines.push(...context.extraDefines);
  return dedupe(defines);
}

export function contextUndefines(context: BuildContext, file?: UVFile): string[] {
  const values = [...context.target.compiler.undefines];
  if (file) {
    values.push(...file.undefines);
  }
  return dedupe(values);
}

export function contextIncludes(context: BuildContext, file?: UVFile): string[] {
  const target = context.target;
  const includes = absoluteIncludes(target, target.compiler.includes);
  if (file) {
    includes.push(...absoluteIncludes(target, file.includes));
  }
  includes.push(...absoluteIncludes(target, context.extraIncludes));

  // µVision adds the folder of the device header (RegisterFile) automatically.
  const registerFile = target.device.registerFile;
  const packPrefix = /^\$\$Device:[^$]*\$(.*)$/.exec(registerFile.trim());
  if (packPrefix && context.pack) {
    const headerPath = path.join(context.pack.dir, packPrefix[1].replace(/[\\/]+/g, path.sep));
    includes.push(path.dirname(headerPath));
  }
  return dedupe(includes.filter((entry) => entry.length > 0));
}

function assemblerDefines(defines: string[], undefines: string[], forAC6: boolean): string[] {
  const args: string[] = [];
  const pushDefinition = (name: string, value: string): void => {
    // armclang's -Wa option is comma separated, so the whole definition must
    // stay inside a single argument (this is exactly what µVision does).
    args.push(forAC6 ? `-Wa,armasm,--pd,${name} SETA ${value}` : '--pd');
    if (!forAC6) {
      args.push(`${name} SETA ${value}`);
    }
  };
  for (const define of defines) {
    if (define.includes('=')) {
      const [name, ...rest] = define.split('=');
      const value = rest.join('=').replace(/^"(.*)"$/, '$1');
      pushDefinition(name, value);
    } else {
      pushDefinition(define, '1');
    }
  }
  for (const undefine of undefines) {
    pushDefinition(undefine, '0');
  }
  return args;
}

function warningLevelArgs(target: UVTarget): string[] {
  if (!target.uAC6) {
    return [];
  }
  // µVision's AC6 default set of suppressed diagnostics (kept for fidelity).
  return [...AC6_WARNING_FLAGS];
}

export function objectFileName(target: UVTarget, file: UVFile, index: number): string {
  const base = path.basename(file.path, path.extname(file.path));
  const safe = base.replace(/[^\w.\-]/g, '_');
  return `${safe}${index > 0 ? `_${index + 1}` : ''}.o`;
}

export function compileCommand(
  context: BuildContext,
  file: UVFile,
  objectPath: string,
  depPath: string
): CommandSpec {
  const target = context.target;
  const toolchain = compilerFor(context);
  const includes = contextIncludes(context, file);
  const defines = contextDefines(context, file);
  const undefines = contextUndefines(context, file);
  const misc = splitCommandLine(file.misc || '');
  const compilerMisc = splitCommandLine(target.compiler.misc || '');
  const assemblerMisc = splitCommandLine(target.assembler.misc || '');
  const relativeSource = path.relative(context.target.project.dir, file.path) || file.path;

  if (file.kind === 'asm') {
    if (target.uAC6) {
      const args = [
        '--target=arm-arm-none-eabi',
        `-mcpu=${ac6Cpu(target)}`,
        '-masm=auto',
        '-c',
      ];
      if (target.debugInformation) {
        args.push('-gdwarf-4');
      }
      for (const include of includes) {
        args.push('-I', include);
      }
      args.push(...assemblerDefines([...defines, ...target.assembler.defines], undefines, true));
      args.push(...assemblerMisc, ...misc);
      args.push('-o', objectPath, relativeSource);
      return {
        tool: toolchain.cc,
        args,
        cwd: target.project.dir,
        label: `Assembling ${path.basename(file.path)}`,
      };
    }
    const args = [`--cpu=${cpuName(target)}`];
    if (target.debugInformation) {
      args.push('-g');
    }
    for (const include of includes) {
      args.push('-I', include);
    }
    args.push(...assemblerDefines([...defines, ...target.assembler.defines], undefines, false));
    args.push(...assemblerMisc, ...misc);
    args.push('-o', objectPath, relativeSource);
    return {
      tool: toolchain.asm,
      args,
      cwd: target.project.dir,
      label: `Assembling ${path.basename(file.path)}`,
    };
  }

  const cpp = file.kind === 'cpp';
  const optimize = target.compiler.optimize || 1;
  const optimizeLevel = Math.min(3, Math.max(0, optimize - 1));

  if (target.uAC6) {
    const args = [
      cpp ? '-xc++' : '-xc',
      cpp ? `-std=${CXX_STANDARDS[target.compiler.lang] ?? 'c++11'}` : target.compiler.gnu ? '-std=gnu99' : '-std=c99',
      '--target=arm-arm-none-eabi',
      `-mcpu=${ac6Cpu(target)}`,
      ...ac6FpuFlags(target),
      '-c',
    ];
    if (cpp) {
      if (target.compiler.rtti) {
        args.push('-frtti');
      } else {
        args.push('-fno-rtti');
      }
    }
    if (!target.compiler.plainChar) {
      args.push('-funsigned-char');
    }
    if (target.compiler.shortEnums) {
      args.push('-fshort-enums');
    }
    if (target.compiler.shortWchar) {
      args.push('-fshort-wchar');
    }
    if (target.compiler.splitSections) {
      args.push('-ffunction-sections');
    }
    if (target.debugInformation) {
      args.push('-gdwarf-4');
    }
    args.push(`-O${optimizeLevel}`);
    args.push(...warningLevelArgs(target));
    if (target.compiler.lto) {
      args.push('-flto');
    }
    for (const define of defines) {
      args.push(`-D${define}`);
    }
    for (const undefine of undefines) {
      args.push(`-U${undefine}`);
    }
    for (const include of includes) {
      args.push('-I', include);
    }
    args.push(...compilerMisc, ...misc);
    args.push('-o', objectPath, '-MD', relativeSource);
    return {
      tool: toolchain.cc,
      args,
      cwd: target.project.dir,
      label: `Compiling ${path.basename(file.path)}`,
    };
  }

  const args = [target.compiler.c99 && !cpp ? '--c99' : '', '-c', '--cpu', cpuName(target)];
  const filtered = args.filter(Boolean);
  if (target.debugInformation) {
    filtered.push('-g');
  }
  filtered.push(`-O${optimizeLevel}`);
  if (target.compiler.optimizeForTime) {
    filtered.push('-Otime');
  }
  if (target.compiler.interwork) {
    filtered.push('--apcs=interwork');
  }
  if (target.compiler.splitSections) {
    filtered.push('--split_sections');
  }
  if (target.compiler.gnu) {
    filtered.push('--gnu');
  }
  filtered.push(...ac5FpuFlags(target));
  if (cpp) {
    filtered.push('--cpp');
  }
  for (const define of defines) {
    filtered.push(`-D${define}`);
  }
  for (const undefine of undefines) {
    filtered.push(`-U${undefine}`);
  }
  for (const include of includes) {
    filtered.push('-I', include);
  }
  filtered.push(...compilerMisc, ...misc);
  filtered.push('-o', objectPath, '--depend', depPath, relativeSource);
  return {
    tool: toolchain.cc,
    args: filtered,
    cwd: target.project.dir,
    label: `Compiling ${path.basename(file.path)}`,
  };
}

export interface LinkOptions {
  objects: string[];
  scatterFile?: string;
  mapFile: string;
  outputFile: string;
  responseFile: string;
}

export function linkArguments(context: BuildContext, options: LinkOptions): string[] {
  const target = context.target;
  const args: string[] = [`--cpu=${cpuName(target)}`];
  if (options.scatterFile) {
    args.push('--scatter', options.scatterFile);
  } else {
    const textAddress = target.linker.textAddress || target.device.irom[0]?.start || 0;
    const dataAddress = target.linker.dataAddress || target.device.iram[0]?.start || 0;
    args.push('--ro_base', `0x${textAddress.toString(16)}`, '--rw_base', `0x${dataAddress.toString(16)}`);
  }
  if (target.useMicrolib) {
    args.push('--library_type=microlib');
  }
  if (target.linker.noStandardLib) {
    args.push('--no_startup');
  }
  args.push('--map', '--summary_stderr', '--info', 'sizes', '--info', 'totals', '--info', 'unused', '--info', 'veneers');
  args.push('--list', options.mapFile, '-o', options.outputFile);
  args.push(...splitCommandLine(target.linker.misc || ''));
  args.push(...options.objects);
  return args;
}

export function writeResponseFile(filePath: string, args: string[]): void {
  const content = args.map(quoteArg).join('\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

export function linkCommand(context: BuildContext, options: LinkOptions): CommandSpec {
  const toolchain = compilerFor(context);
  const responsePath = path.isAbsolute(options.responseFile)
    ? options.responseFile
    : path.resolve(context.target.project.dir, options.responseFile);
  writeResponseFile(responsePath, linkArguments(context, options));
  return {
    tool: toolchain.link,
    args: ['--via', responsePath],
    cwd: context.target.project.dir,
    label: 'Linking',
  };
}

export function fromelfCommand(
  context: BuildContext,
  format: 'hex' | 'bin',
  outputFile: string,
  elfFile: string
): CommandSpec {
  const toolchain = compilerFor(context);
  const formatFlag = format === 'hex' ? '--i32combined' : '--bin';
  return {
    tool: toolchain.fromelf,
    args: [formatFlag, '--output', outputFile, elfFile],
    cwd: context.target.project.dir,
    label: format === 'hex' ? 'Creating HEX file' : 'Creating BIN file',
  };
}

export function archiveCommand(context: BuildContext, outputFile: string, objects: string[]): CommandSpec {
  const toolchain = compilerFor(context);
  const args = ['--create'];
  if (context.target.uAC6) {
    args.push('--target=arm-arm-none-eabi');
  }
  args.push(outputFile, ...objects);
  return { tool: toolchain.armar, args, cwd: context.target.project.dir, label: 'Creating library' };
}

/** A human readable, copy/paste-able command line (used by "Show Resolved Commands"). */
export function describeCommand(spec: CommandSpec): string {
  return formatCommand(spec.tool, spec.args);
}
