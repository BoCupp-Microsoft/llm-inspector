// First-time (idempotent) setup: install mitmproxy, generate the repo-local CA, install npm
// deps, build the web UI, and create local (gitignored) folders. Safe to re-run.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONFDIR = join(REPO_ROOT, '.mitmproxy');
const CA_PEM = join(CONFDIR, 'mitmproxy-ca-cert.pem');
const PY = process.env.PYTHON || 'python';
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  // .cmd/.bat shims (e.g. npm.cmd) must run through a shell on Windows.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: needsShell, ...opts });
  return r.status === 0;
}
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

console.log('== agent-loop setup ==');

// 1. Python
console.log('\n[1/5] Checking Python...');
const pyv = capture(PY, ['--version']);
if (!pyv) {
  console.error(`  Python not found (tried "${PY}"). Install Python 3.9+ or set PYTHON=<path>.`);
  process.exit(1);
}
console.log('  ' + pyv);

// 2. mitmproxy
console.log('\n[2/5] Ensuring mitmproxy is installed...');
if (spawnSync(PY, ['-c', 'import mitmproxy'], { stdio: 'ignore' }).status !== 0) {
  console.log('  installing mitmproxy via pip...');
  if (!run(PY, ['-m', 'pip', 'install', 'mitmproxy'])) {
    console.error('  pip install mitmproxy failed.');
    process.exit(1);
  }
} else {
  console.log('  already installed.');
}

// 3. repo-local CA
console.log('\n[3/5] Generating repo-local mitmproxy CA (.mitmproxy/)...');
if (!existsSync(CONFDIR)) mkdirSync(CONFDIR, { recursive: true });
if (existsSync(CA_PEM)) {
  console.log('  CA already present.');
} else {
  const scriptsDir = capture(PY, ['-c', "import sysconfig;print(sysconfig.get_path('scripts'))"]);
  const mitmdump = scriptsDir
    ? join(scriptsDir, process.platform === 'win32' ? 'mitmdump.exe' : 'mitmdump')
    : 'mitmdump';
  const gen = spawnSync(mitmdump, ['--set', `confdir=${CONFDIR}`, '--listen-port', '0', '-q'], {
    timeout: 12000,
    stdio: 'ignore',
  });
  void gen;
  console.log(existsSync(CA_PEM) ? '  CA generated.' : '  (CA will be generated on first run)');
}

// 4. npm deps + build
console.log('\n[4/5] Installing npm dependencies and building the viewer...');
if (!existsSync(join(REPO_ROOT, 'node_modules'))) {
  if (!run(NPM, ['install'], { cwd: REPO_ROOT })) {
    console.error('  npm install failed.');
    process.exit(1);
  }
}
if (!run(NPM, ['run', 'build'], { cwd: REPO_ROOT })) {
  console.error('  Web build failed. On some corporate npm mirrors esbuild needs its install');
  console.error('  script approved (e.g. `npm approve-scripts esbuild`), then re-run setup.');
  process.exit(1);
}

// 5. local folders + .env
console.log('\n[5/5] Creating local folders and .env...');
for (const d of ['sessions', 'secrets']) {
  const p = join(REPO_ROOT, d);
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}
const env = join(REPO_ROOT, '.env');
const example = join(REPO_ROOT, '.env.example');
if (!existsSync(env)) {
  if (existsSync(example)) copyFileSync(example, env);
  else writeFileSync(env, 'PROXY_PORT=8080\nVIEWER_PORT=8090\nCOPILOT_CMD=copilot\n');
  console.log('  wrote .env');
} else {
  console.log('  .env already present.');
}

console.log('\nDone. Next:');
console.log('  1) (optional) trust .mitmproxy/mitmproxy-ca-cert.cer in your OS to inspect non-CLI traffic');
console.log('  2) npm run trace        # launches copilot through the tracer');
console.log('  3) open http://127.0.0.1:8090');
