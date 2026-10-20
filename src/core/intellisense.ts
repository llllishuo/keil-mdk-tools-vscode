/**
 * Generation of the VS Code C/C++ IntelliSense configuration for a µVision
 * target (the equivalent of uVision's "Options for Target -> C/C++" include
 * paths and defines).
 */

import * as path from 'path';
import { BuildContext, contextDefines, contextIncludes } from './commands';
import { UVTarget } from './uvprojx';

export interface CppToolsConfiguration {
  name: string;
  includePath: string[];
  defines: string[];
  compilerPath?: string;
  cStandard: string;
  cppStandard: string;
  intelliSenseMode: string;
  browse?: { path: string[]; limitSymbolsToIncludedHeaders: boolean };
}

const CXX_STANDARDS: Record<number, string> = {
  1: 'c++98',
  2: 'c++03',
  3: 'c++11',
  4: 'c++14',
  5: 'c++17',
  6: 'c++2a',
};

export function intellisenseConfigName(target: UVTarget): string {
  return `Keil: ${target.name}`;
}

export function buildIntellisenseConfiguration(context: BuildContext): CppToolsConfiguration {
  const target = context.target;
  const toolchain = target.uAC6 ? context.install.ac6 : context.install.ac5;
  const includePath = contextIncludes(context);
  // contextDefines already contains the uVision version macro
  // (__UVISION_VERSION=536), which is what the toolchain sees as well.
  const defines = contextDefines(context);
  const config: CppToolsConfiguration = {
    name: intellisenseConfigName(target),
    includePath,
    defines,
    compilerPath: toolchain?.cc,
    cStandard: 'c99',
    cppStandard: CXX_STANDARDS[target.compiler.lang] ?? 'c++11',
    intelliSenseMode: 'windows-gcc-arm',
    browse: { path: includePath, limitSymbolsToIncludedHeaders: true },
  };
  if (!config.compilerPath) {
    delete config.compilerPath;
  }
  return config;
}

/**
 * Merge a generated configuration into an existing c_cpp_properties.json
 * document without touching the user's other configurations.
 */
export function mergeCppProperties(
  existing: any,
  configuration: CppToolsConfiguration
): { document: any; changed: boolean } {
  const document = existing && typeof existing === 'object' ? existing : {};
  const configurations: any[] = Array.isArray(document.configurations) ? document.configurations : [];
  const index = configurations.findIndex(
    (entry) => entry && typeof entry.name === 'string' && entry.name === configuration.name
  );
  let changed = false;
  if (index >= 0) {
    const previous = JSON.stringify(configurations[index]);
    if (previous !== JSON.stringify(configuration)) {
      configurations[index] = configuration;
      changed = true;
    }
  } else {
    configurations.push(configuration);
    changed = true;
  }
  const documentChanged = changed || !Array.isArray(document.configurations);
  document.configurations = configurations;
  if (!document.version && documentChanged) {
    document.version = 4;
  }
  return { document, changed: documentChanged };
}

export function projectWorkspaceFolder(projectDir: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, projectDir);
  return relative && !relative.startsWith('..') ? relative : projectDir;
}
