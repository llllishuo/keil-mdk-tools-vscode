import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseXML, child, childText } from '../core/xml';
import { parseUVProject } from '../core/uvprojx';
import { parseOutput } from '../core/diagnostics';
import { compileCommand, linkArguments, BuildContext } from '../core/commands';
import { decideEngine } from '../core/engine';
import { mergeCppProperties, buildIntellisenseConfiguration } from '../core/intellisense';
import { mergeLaunchConfiguration } from '../core/debugConfig';
import { objectTargets, readProgramSize } from '../core/nativeBuild';
import { KeilInstall, Toolchain } from '../core/tools';

const PROJECT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<Project xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SchemaVersion>2.1</SchemaVersion>
  <Targets>
    <Target>
      <TargetName>Debug</TargetName>
      <uAC6>1</uAC6>
      <TargetOption>
        <TargetCommonOption>
          <Device>STM32F103ZE</Device>
          <Vendor>STMicroelectronics</Vendor>
          <PackID>Keil.STM32F1xx_DFP.2.3.0</PackID>
          <Cpu>IRAM(0x20000000,0x00010000) IROM(0x08000000,0x00080000) CPUTYPE("Cortex-M3") CLOCK(12000000) ELITTLE</Cpu>
          <OutputDirectory>.\\Objects\\</OutputDirectory>
          <OutputName>demo</OutputName>
          <CreateExecutable>1</CreateExecutable>
          <CreateHexFile>1</CreateHexFile>
          <DebugInformation>1</DebugInformation>
          <ListingPath>.\\Listings\\</ListingPath>
          <RegisterFile>$$Device:STM32F103ZE$Device\\Include\\stm32f10x.h</RegisterFile>
          <SFDFile>$$Device:STM32F103ZE$SVD\\STM32F103xx.svd</SFDFile>
        </TargetCommonOption>
        <TargetArmAds>
          <ArmAdsMisc>
            <useUlib>1</useUlib>
            <OnChipMemories>
              <IROM><Type>1</Type><StartAddress>0x08000000</StartAddress><Size>0x80000</Size></IROM>
              <IRAM><Type>0</Type><StartAddress>0x20000000</StartAddress><Size>0x10000</Size></IRAM>
              <OCR_RVCT4><Type>1</Type><StartAddress>0x08000000</StartAddress><Size>0x80000</Size></OCR_RVCT4>
              <OCR_RVCT9><Type>0</Type><StartAddress>0x20000000</StartAddress><Size>0x10000</Size></OCR_RVCT9>
            </OnChipMemories>
          </ArmAdsMisc>
          <Cads>
            <interw>1</interw>
            <Optim>2</Optim>
            <OneElfS>1</OneElfS>
            <uC99>1</uC99>
            <vShortEn>1</vShortEn>
            <vShortWch>1</vShortWch>
            <VariousControls>
              <Define>USE_HAL_DRIVER,STM32F103xE</Define>
              <IncludePath>inc;..\\common</IncludePath>
              <MiscControls>-DFOO=1</MiscControls>
            </VariousControls>
          </Cads>
          <Aads>
            <interw>1</interw>
            <VariousControls>
              <Define>ASM_DEFINE</Define>
            </VariousControls>
          </Aads>
          <LDads>
            <umfTarg>1</umfTarg>
            <useFile>0</useFile>
            <ScatterFile></ScatterFile>
            <TextAddressRange>0x08000000</TextAddressRange>
            <DataAddressRange>0x20000000</DataAddressRange>
          </LDads>
        </TargetArmAds>
      </TargetOption>
      <Groups>
        <Group>
          <GroupName>Source</GroupName>
          <Files>
            <File>
              <FileName>main.c</FileName>
              <FileType>1</FileType>
              <FilePath>src\\main.c</FilePath>
            </File>
            <File>
              <FileName>util.c</FileName>
              <FileType>1</FileType>
              <FilePath>src\\other\\util.c</FilePath>
            </File>
            <File>
              <FileName>excluded.c</FileName>
              <FileType>1</FileType>
              <FilePath>src\\excluded.c</FilePath>
              <FileOption>
                <CommonProperty>
                  <IncludeInBuild>0</IncludeInBuild>
                </CommonProperty>
              </FileOption>
            </File>
            <File>
              <FileName>startup.s</FileName>
              <FileType>2</FileType>
              <FilePath>src\\startup.s</FilePath>
            </File>
          </Files>
        </Group>
      </Groups>
    </Target>
  </Targets>
</Project>`;

function writeProjectFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keil-test-'));
  const file = path.join(dir, 'demo.uvprojx');
  fs.writeFileSync(file, PROJECT_XML, 'utf8');
  fs.mkdirSync(path.join(dir, 'src', 'other'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'main.c'), 'int main(void){return 0;}', 'utf8');
  return file;
}

function fakeToolchain(version: 'AC5' | 'AC6', root: string): Toolchain {
  return {
    version,
    bin: root,
    cc: path.join(root, version === 'AC6' ? 'armclang.exe' : 'armcc.exe'),
    asm: path.join(root, 'armasm.exe'),
    link: path.join(root, 'armlink.exe'),
    fromelf: path.join(root, 'fromelf.exe'),
    armar: path.join(root, 'armar.exe'),
  };
}

function fakeInstall(): KeilInstall {
  const root = 'C:\\Keil_v5';
  return {
    root,
    toolsIni: path.join(root, 'TOOLS.INI'),
    uvisionExe: path.join(root, 'UV4', 'UV4.exe'),
    packsRoot: path.join(root, 'packs'),
    ac5: fakeToolchain('AC5', path.join(root, 'ARM', 'ARMCC', 'bin')),
    ac6: fakeToolchain('AC6', path.join(root, 'ARM', 'ARMCLANG', 'bin')),
    version: '5.36',
  };
}

function test(name: string, fn: () => void | Promise<void>): void {
  // node:test is available in Node 18+; keep the harness dependency free.
  const nodeTest = require('node:test') as typeof import('node:test');
  nodeTest.test(name, fn);
}

test('xml parser handles attributes, entities and CDATA', () => {
  const root = parseXML(
    '<?xml version="1.0"?><!-- c --><root a="1" b=\'two\'><x>&lt;tag&gt; &amp; more</x><y><![CDATA[raw <data>]]></y><z/></root>'
  );
  assert.strictEqual(root.name, 'root');
  assert.strictEqual(root.attributes.a, '1');
  assert.strictEqual(root.attributes.b, 'two');
  assert.strictEqual(childText(root, 'x'), '<tag> & more');
  assert.strictEqual(childText(root, 'y'), 'raw <data>');
  assert.ok(child(root, 'z'));
});

test('uvprojx model resolves targets, paths, options and file kinds', () => {
  const file = writeProjectFixture();
  const project = parseUVProject(file);
  assert.strictEqual(project.targets.length, 1);
  const target = project.targets[0];
  assert.strictEqual(target.name, 'Debug');
  assert.strictEqual(target.uAC6, true);
  assert.strictEqual(target.device.name, 'STM32F103ZE');
  assert.strictEqual(target.device.cpuType, 'Cortex-M3');
  assert.strictEqual(target.device.irom[0].start, 0x08000000);
  assert.strictEqual(target.createHex, true);
  assert.strictEqual(target.useMicrolib, true);
  assert.strictEqual(target.compiler.c99, true);
  assert.strictEqual(target.compiler.optimize, 2);
  assert.deepStrictEqual(target.compiler.defines, ['USE_HAL_DRIVER', 'STM32F103xE']);
  assert.deepStrictEqual(target.compiler.includes, ['inc', '..\\common']);
  assert.strictEqual(path.normalize(target.outputDir), path.normalize(path.join(project.dir, 'Objects')));
  assert.strictEqual(target.groups[0].files.length, 4);
  assert.strictEqual(target.groups[0].files[0].kind, 'c');
  assert.strictEqual(target.groups[0].files[3].kind, 'asm');
  assert.strictEqual(target.groups[0].files[2].includeInBuild, false);
  assert.deepStrictEqual(target.assembler.defines, ['ASM_DEFINE']);
});

test('object names are unique and stable when basenames collide', () => {
  const file = writeProjectFixture();
  const target = parseUVProject(file).targets[0];
  target.groups[0].files.push({
    name: 'main.c',
    path: path.join(target.project.dir, 'src', 'duplicate', 'main.c'),
    type: 1,
    kind: 'c',
    includeInBuild: true,
    defines: [],
    undefines: [],
    includes: [],
    misc: '',
  });
  const targets = objectTargets(target);
  const names = targets.map((entry) => path.basename(entry.objectRel));
  assert.strictEqual(new Set(names).size, names.length);
  assert.ok(names.some((name) => name === 'main.o'));
  assert.ok(names.some((name) => name === 'main_2.o'));
});

test('AC6 compile command mirrors uVision flags', () => {
  const project = parseUVProject(writeProjectFixture());
  const target = project.targets[0];
  const install = fakeInstall();
  const context: BuildContext = {
    install,
    target,
    pack: undefined,
    extraDefines: ['EXTRA=1'],
    extraIncludes: [],
  };
  const file = target.groups[0].files[0];
  const spec = compileCommand(context, file, path.join('Objects', 'main.o'), path.join('Objects', 'main.d'));
  const args = spec.args.join(' ');
  assert.ok(spec.tool.endsWith('armclang.exe'));
  assert.ok(args.includes('-xc'));
  assert.ok(args.includes('-std=c99'));
  assert.ok(args.includes('-mcpu=cortex-m3'));
  assert.ok(args.includes('-O1'));
  assert.ok(args.includes('-ffunction-sections'));
  assert.ok(args.includes('-DUSE_HAL_DRIVER'));
  assert.ok(args.includes('-DEXTRA=1'));
  assert.ok(args.includes('-DFOO=1'));
  assert.ok(args.includes('-I'));
  assert.ok(args.includes('-o'));
  assert.ok(args.includes('-MD'));
  assert.ok(args.includes('src\\main.c'));
});

test('AC5 compile and assembler commands match uVision flags', () => {
  const project = parseUVProject(writeProjectFixture());
  const target = project.targets[0];
  target.uAC6 = false;
  const install = fakeInstall();
  const context: BuildContext = { install, target, pack: undefined, extraDefines: [], extraIncludes: [] };
  const cFile = target.groups[0].files[0];
  const spec = compileCommand(context, cFile, 'Objects\\main.o', 'Objects\\main.d');
  const args = spec.args.join(' ');
  assert.ok(spec.tool.endsWith('armcc.exe'));
  assert.ok(args.includes('--c99'));
  assert.ok(args.includes('--cpu Cortex-M3'));
  assert.ok(args.includes('-O1'));
  assert.ok(args.includes('--apcs=interwork'));
  assert.ok(args.includes('--split_sections'));
  assert.ok(args.includes('--depend'));

  const asmFile = target.groups[0].files[3];
  const asmSpec = compileCommand(context, asmFile, 'Objects\\startup.o', 'Objects\\startup.d');
  assert.ok(asmSpec.tool.endsWith('armasm.exe'));
  assert.ok(asmSpec.args.includes('--pd'));
  assert.ok(asmSpec.args.includes('ASM_DEFINE SETA 1'));

  const ac6Spec = compileCommand(
    { ...context, target: { ...target, uAC6: true } },
    asmFile,
    'Objects\\startup.o',
    'Objects\\startup.d'
  );
  assert.ok(ac6Spec.args.some((arg) => arg.startsWith('-Wa,armasm,--pd,')));
});

test('link arguments use scatter file and microlib', () => {
  const project = parseUVProject(writeProjectFixture());
  const target = project.targets[0];
  const install = fakeInstall();
  const context: BuildContext = { install, target, pack: undefined, extraDefines: [], extraIncludes: [] };
  const args = linkArguments(context, {
    objects: ['Objects\\main.o', 'Objects\\startup.o'],
    scatterFile: 'Objects\\demo.sct',
    mapFile: 'Listings\\demo.map',
    outputFile: 'Objects\\demo.axf',
    responseFile: 'Objects\\demo.lnp',
  });
  const text = args.join(' ');
  assert.ok(text.includes('--cpu=Cortex-M3'));
  assert.ok(text.includes('--scatter Objects\\demo.sct'));
  assert.ok(text.includes('--library_type=microlib'));
  assert.ok(text.includes('-o Objects\\demo.axf'));
});

test('diagnostics parser understands AC5, AC6, armasm, armlink and uVision lines', () => {
  const output = [
    '..\\User\\main.c(12): error:  #20: identifier "x" is undefined',
    'main.c:14:5: warning: unused variable \'y\'',
    '"..\\User\\startup.s", line 8: Error: A1137E: Unexpected characters at end of line',
    'Error: L6218E: Undefined symbol foo (referred from main.o).',
    '.\\Objects\\demo.axf: error: L6002U: Could not open file .\\objects\\main.o',
    '".\\Objects\\demo.axf" - 4 Error(s), 1 Warning(s).',
  ].join('\r\n');
  const result = parseOutput(output, { projectDir: 'C:\\proj' });
  assert.strictEqual(result.errors, 4);
  assert.strictEqual(result.warnings, 1);
  const messages = result.diagnostics.map((entry) => entry.message).join('|');
  assert.ok(messages.includes('identifier "x" is undefined'));
  assert.ok(messages.includes('Unexpected characters'));
  assert.ok(messages.includes('Could not open file'));
  const errorEntry = result.diagnostics.find((entry) => entry.code === '20' || entry.code === '#20');
  assert.ok(errorEntry);
  assert.strictEqual(errorEntry.line, 12);
});

test('engine selection follows project needs and availability', () => {
  const project = parseUVProject(writeProjectFixture());
  const target = project.targets[0];
  const install = fakeInstall();
  const uv4 = path.join(os.tmpdir(), `uv4-${Date.now()}.exe`);
  fs.writeFileSync(uv4, '');
  try {
    const nativeDecision = decideEngine('auto', { install, target, project }, uv4);
    assert.strictEqual(nativeDecision.mode, 'native');

    project.usesRte = true;
    const rteDecision = decideEngine('auto', { install, target, project }, uv4);
    assert.strictEqual(rteDecision.mode, 'uv4');

    const noNative: KeilInstall = { ...install, ac5: undefined, ac6: undefined };
    const fallback = decideEngine('auto', { install: noNative, target, project }, uv4);
    assert.strictEqual(fallback.mode, 'uv4');

    assert.throws(() => decideEngine('native', { install: noNative, target, project }, uv4));
    assert.throws(() => decideEngine('uv4', { install, target, project }, 'C:\\missing\\UV4.exe'));
  } finally {
    fs.unlinkSync(uv4);
  }
});

test('IntelliSense merge keeps other configurations and avoids duplicates', () => {
  const existing = {
    version: 4,
    configurations: [{ name: 'Existing', includePath: ['x'] }],
  };
  const generated = buildIntellisenseConfiguration({
    install: fakeInstall(),
    target: parseUVProject(writeProjectFixture()).targets[0],
    pack: undefined,
    extraDefines: [],
    extraIncludes: [],
  });
  const first = mergeCppProperties(existing, generated);
  assert.strictEqual(first.document.configurations.length, 2);
  const second = mergeCppProperties(first.document, generated);
  assert.strictEqual(second.changed, false);
  assert.strictEqual(second.document.configurations.length, 2);
  assert.strictEqual(second.document.configurations[0].name, 'Existing');
  assert.strictEqual(second.document.version, 4);
});

test('launch configuration merge replaces by name', () => {
  const existing = { version: '0.2.0', configurations: [{ name: 'Keil: Debug', type: 'cortex-debug' }] };
  const merged = mergeLaunchConfiguration(existing, { name: 'Keil: Debug', type: 'cortex-debug', servertype: 'openocd' });
  assert.strictEqual(merged.document.configurations.length, 1);
  assert.strictEqual(merged.document.configurations[0].servertype, 'openocd');
});

test('program size is read from the linker map', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keil-map-'));
  const map = path.join(dir, 'demo.map');
  fs.writeFileSync(
    map,
    '      Code (inc. data)   RO Data    RW Data    ZI Data      Debug\n' +
      '      7832        430        360         28       2044     564061   Grand Totals\n'
  );
  assert.strictEqual(readProgramSize(map), 'Program Size: Code=7832 RO-data=360 RW-data=28 ZI-data=2044');
});
