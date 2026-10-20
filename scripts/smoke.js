/* Development smoke test: runs the extension against a mocked VS Code API. */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const vscode = require('./vscode-mock');

const projectFile = process.argv[2];
if (!projectFile) {
  console.error('usage: node scripts/smoke.js <project.uvprojx>');
  process.exit(2);
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

vscode.__files = [projectFile];
vscode.__settings = {
  'keil.root': 'C:\\Keil_v5',
  'keil.build.engine': 'auto',
  'keil.build.jobs': 2,
  'keil.build.cleanBeforeBuild': false,
  'keil.build.extraDefines': [],
  'keil.build.extraIncludes': [],
  'keil.uv4.path': '',
  'keil.flash.command': '',
  'keil.intellisense.auto': false,
  'keil.debug.serverType': 'auto',
  'keil.tree.autoDiscover': true,
};

const workspaceState = {
  get: (key, fallback) => (vscode.__state.has(key) ? vscode.__state.get(key) : fallback),
  update: async (key, value) => {
    vscode.__state.set(key, value);
  },
};
const context = {
  subscriptions: [],
  workspaceState,
  globalState: workspaceState,
  extensionPath: __dirname,
};

const extension = require('../out/extension');

function assert(condition, message) {
  if (!condition) {
    throw new Error('ASSERTION FAILED: ' + message);
  }
  console.log('  ok - ' + message);
}

(async () => {
  extension.activate(context);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const output = context.subscriptions.find((entry) => entry && entry.lines);
  const run = async (id, arg) => {
    const handler = vscode.__commands.get(id);
    assert(handler, `command ${id} registered`);
    return handler(arg);
  };

  console.log('commands: ' + [...vscode.__commands.keys()].join(', '));

  await run('keil.build');
  console.log('  build output tail:');
  for (const line of output.lines.slice(-6)) {
    console.log('    ' + line);
  }

  const diag = vscode.__diagnostics();
  if (process.env.KEIL_SMOKE_EXPECT_ERROR) {
    assert(output.lines.some((line) => /Build failed/.test(line)), 'build reported failure');
    assert(diag.size > 0, 'diagnostics were published for the failing file');
    const firstFile = [...diag.keys()][0];
    const list = diag.get(firstFile);
    assert(list.length > 0 && list[0].severity === 0, 'first diagnostic is an error');
    console.log('\nERROR SMOKE TEST PASSED');
    process.exit(0);
  }

  assert(output.lines.some((line) => /Program Size: Code=/.test(line)), 'build printed Program Size');
  assert(output.lines.some((line) => /Build succeeded/.test(line)), 'build succeeded');
  assert(diag.size === 0, 'no diagnostics for a clean build');

  await run('keil.generateIntelliSense');
  const cppProps = path.join(path.dirname(projectFile), '.vscode', 'c_cpp_properties.json');
  assert(fs.existsSync(cppProps), 'c_cpp_properties.json written');
  const cpp = JSON.parse(fs.readFileSync(cppProps, 'utf8'));
  assert(Array.isArray(cpp.configurations) && cpp.configurations.length >= 1, 'cpptools configurations present');
  assert(cpp.configurations[0].includePath.length >= 1, 'includePath populated');

  await run('keil.createDebugConfig');
  const launch = path.join(path.dirname(projectFile), '.vscode', 'launch.json');
  assert(fs.existsSync(launch), 'launch.json written');
  const launchJson = JSON.parse(fs.readFileSync(launch, 'utf8'));
  assert(launchJson.configurations[0].type === 'cortex-debug', 'cortex-debug launch configuration');

  await run('keil.showCommands');
  assert(vscode.__documents.some((doc) => /armclang|armcc/.test(doc.content)), 'resolved commands document created');

  vscode.__settings['keil.flash.command'] = 'cmd /c echo FLASH_OK';
  await run('keil.flash');
  assert(
    vscode.__notifications.some((entry) => /flash command finished/.test(entry.message)),
    'external flash command executed'
  );

  const clean = vscode.__commands.get('keil.clean');
  await clean();
  assert(output.lines.some((line) => /Clean finished/.test(line)), 'clean command ran');

  console.log('\nSMOKE TEST PASSED');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
