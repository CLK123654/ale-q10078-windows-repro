import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

const repoRoot = path.resolve(import.meta.dirname, '..');
const artifactRoot = fs.existsSync(path.join(repoRoot, 'artifacts')) ? path.join(repoRoot, 'artifacts') : repoRoot;
const evidenceRoot = path.join(repoRoot, 'verification', 'evidence');
const attachmentNames = ['输入数据包.zip', 'reference.zip', '关键标准答案.xlsx', '任务规格转化.xlsx'];
const expectedReferenceFiles = [
  'artifacts/agent-billing-after-feed.png', 'playwright.config.ts', 'reports/case_results.csv',
  'reports/focus_path.csv', 'reports/socket_event_audit.csv', 'tests/support_console_realtime.spec.ts',
];

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function parseZip(file) {
  const data = fs.readFileSync(file);
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= data.length) {
    const signature = data.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const flags = data.readUInt16LE(offset + 6);
    const method = data.readUInt16LE(offset + 8);
    const compressedSize = data.readUInt32LE(offset + 18);
    const uncompressedSize = data.readUInt32LE(offset + 22);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    if (flags & 0x08) throw new Error('ZIP数据描述符不受支持');
    const name = data.subarray(offset + 30, offset + 30 + nameLength).toString('utf8').replaceAll('\\', '/');
    const start = offset + 30 + nameLength + extraLength;
    const compressed = data.subarray(start, start + compressedSize);
    if (!name.endsWith('/')) {
      const body = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (!body || body.length !== uncompressedSize) throw new Error(`无法解压${name}`);
      files.set(name, body);
    }
    offset = start + compressedSize;
  }
  return files;
}

async function extractZip(file, destination) {
  for (const [name, bytes] of parseZip(file)) {
    const target = path.resolve(destination, name);
    if (!target.startsWith(path.resolve(destination) + path.sep)) throw new Error(`非法ZIP路径${name}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, bytes);
  }
}

function normalizedText(bytes) {
  return bytes.toString('utf8').replace(/\r\n/gu, '\n');
}

function csvRows(bytes) {
  const lines = normalizedText(bytes).trimEnd().split('\n');
  const headers = lines.shift().split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((value, index) => [headers[index], value])));
}

function xlsxSheetNames(bytes) {
  const archive = parseZipBytes(bytes);
  const workbook = archive.get('xl/workbook.xml')?.toString('utf8') ?? '';
  return [...workbook.matchAll(/<(?:[A-Za-z]+:)?sheet[^>]+name="([^"]+)"/gu)].map((match) => match[1]);
}

function parseZipBytes(bytes) {
  const temp = path.join(os.tmpdir(), `q10078-${process.pid}-${Math.random().toString(16).slice(2)}.zip`);
  fs.writeFileSync(temp, bytes);
  try { return parseZip(temp); } finally { fs.unlinkSync(temp); }
}

function digestTree(root, ignored = new Set()) {
  const entries = [];
  function visit(current, prefix = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored.has(relative.split('/')[0])) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full, relative);
      else entries.push(`${relative}\0${sha256File(full)}`);
    }
  }
  visit(root);
  return sha256Bytes(Buffer.from(entries.join('\n')));
}

async function run(command, args, cwd, env = {}) {
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code: code ?? 1, stdout, stderr, elapsed_ms: Date.now() - started }));
  });
}

async function prepareRun(label, mutation) {
  const runRoot = path.join(os.tmpdir(), label);
  await fsp.rm(runRoot, { recursive: true, force: true });
  await fsp.mkdir(runRoot, { recursive: true });
  await extractZip(path.join(artifactRoot, '输入数据包.zip'), runRoot);
  const inputRoot = path.join(runRoot, 'input_data');
  const reference = parseZip(path.join(artifactRoot, 'reference.zip'));
  await fsp.writeFile(path.join(inputRoot, 'tests/support_console_realtime.spec.ts'), reference.get('tests/support_console_realtime.spec.ts'));
  await fsp.writeFile(path.join(inputRoot, 'playwright.config.ts'), reference.get('playwright.config.ts'));
  if (mutation) await mutation(inputRoot);
  return { runRoot, inputRoot };
}

async function installRuntime(inputRoot) {
  const installDependencies = await run('npm', ['ci'], inputRoot);
  if (installDependencies.code !== 0) throw new Error(`npm ci失败\n${installDependencies.stderr}`);
  const installBrowser = await run('npm', ['exec', '--', 'playwright', 'install', 'chromium'], inputRoot);
  if (installBrowser.code !== 0) throw new Error(`Chromium安装失败\n${installBrowser.stdout}\n${installBrowser.stderr}`);
  return {
    dependency_exit_code: installDependencies.code,
    browser_exit_code: installBrowser.code,
  };
}

function semanticResults(root) {
  const caseRows = csvRows(fs.readFileSync(path.join(root, 'reports/case_results.csv')));
  const eventRows = csvRows(fs.readFileSync(path.join(root, 'reports/socket_event_audit.csv')));
  const focusRows = csvRows(fs.readFileSync(path.join(root, 'reports/focus_path.csv')));
  const payload = { caseRows, eventRows, focusRows };
  return { payload, digest: sha256Bytes(Buffer.from(JSON.stringify(payload))) };
}

function compareReference(root) {
  const reference = parseZip(path.join(artifactRoot, 'reference.zip'));
  for (const name of expectedReferenceFiles) {
    const actual = fs.readFileSync(path.join(root, name));
    const expected = reference.get(name);
    if (!expected) throw new Error(`Reference缺少${name}`);
    if (name.endsWith('.png')) {
      if (actual.readUInt32BE(0) !== 0x89504e47 || actual.length < 10000) throw new Error('截图不可读');
      if (actual.readUInt32BE(16) !== 1280 || actual.readUInt32BE(20) !== 720) throw new Error('截图尺寸错误');
    } else if (normalizedText(actual) !== normalizedText(expected)) {
      throw new Error(`${name}与Reference不一致`);
    }
  }
}

await fsp.rm(evidenceRoot, { recursive: true, force: true });
await fsp.mkdir(evidenceRoot, { recursive: true });

const attachmentSha256 = Object.fromEntries(attachmentNames.map((name) => [name, sha256File(path.join(artifactRoot, name))]));
const referenceMembers = [...parseZip(path.join(artifactRoot, 'reference.zip')).keys()].toSorted();
if (JSON.stringify(referenceMembers) !== JSON.stringify(expectedReferenceFiles.toSorted())) throw new Error('Reference成员不符合交付清单');

const answerSheets = xlsxSheetNames(fs.readFileSync(path.join(artifactRoot, '关键标准答案.xlsx')));
const expectedAnswerSheets = ['交付物答案清单', '固定字段答案', '固定集合答案', '固定数值答案', '允许变体答案'];
if (JSON.stringify(answerSheets) !== JSON.stringify(expectedAnswerSheets)) throw new Error('关键标准答案Sheet顺序错误');
if (JSON.stringify(xlsxSheetNames(fs.readFileSync(path.join(artifactRoot, '任务规格转化.xlsx')))) !== JSON.stringify(['任务规格转化'])) throw new Error('任务规格Sheet错误');

const cleanRuns = [];
for (const label of ['Q10078 第一次 干净目录', 'Q10078 第二次 中文 路径']) {
  const prepared = await prepareRun(label);
  const before = digestTree(prepared.inputRoot, new Set(['node_modules', 'reports', 'artifacts', '.playwright-results']));
  const installation = await installRuntime(prepared.inputRoot);
  const task = await run('npm', ['run', 'test:e2e'], prepared.inputRoot);
  if (task.code !== 0) throw new Error(`浏览器运行失败\n${task.stdout}\n${task.stderr}`);
  const after = digestTree(prepared.inputRoot, new Set(['node_modules', 'reports', 'artifacts', '.playwright-results']));
  if (before !== after) throw new Error('业务输入在运行中发生变化');
  compareReference(prepared.inputRoot);
  const semantic = semanticResults(prepared.inputRoot);
  cleanRuns.push({ directory_label: label, installation, exit_code: task.code, input_digest_before: before, input_digest_after: after, semantic_digest: semantic.digest, elapsed_ms: task.elapsed_ms });
}
if (cleanRuns[0].semantic_digest !== cleanRuns[1].semantic_digest) throw new Error('两次运行的结构化结果不一致');

const mutation = await prepareRun('Q10078 有效输入变化', async (inputRoot) => {
  const file = path.join(inputRoot, 'fixtures/socket_feed.json');
  const value = JSON.parse(await fsp.readFile(file, 'utf8'));
  value.find((event) => event.event_id === 'S01').unread_delta = 4;
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
});
await installRuntime(mutation.inputRoot);
let result = await run('npm', ['run', 'test:e2e'], mutation.inputRoot);
if (result.code !== 0) throw new Error(`变化用例失败\n${result.stdout}\n${result.stderr}`);
const mutationRows = semanticResults(mutation.inputRoot);
const changedS01 = mutationRows.payload.eventRows.find((row) => row.event_id === 'S01');
if (changedS01.after !== '5' || mutationRows.digest === cleanRuns[0].semantic_digest) throw new Error('有效输入变化没有改变业务结果');

const negative = await prepareRun('Q10078 无效输入', async (inputRoot) => {
  await fsp.rm(path.join(inputRoot, 'fixtures/agent_roles.json'));
});
await installRuntime(negative.inputRoot);
result = await run('npm', ['run', 'test:e2e'], negative.inputRoot);
const deliverablesAbsent = !fs.existsSync(path.join(negative.inputRoot, 'reports')) && !fs.existsSync(path.join(negative.inputRoot, 'artifacts'));
if (result.code === 0 || !deliverablesAbsent) throw new Error('无效输入没有失败关闭');

const evidence = {
  schema_version: 1,
  task_asset_id: 'playwright_support_console_realtime_regression',
  result: 'PASS',
  generated_at_utc: new Date().toISOString(),
  git_commit_sha: process.env.GITHUB_SHA ?? 'local',
  workflow_run_id: process.env.GITHUB_RUN_ID ?? 'local',
  runner: {
    os: process.env.RUNNER_OS ?? process.platform,
    arch: process.env.RUNNER_ARCH ?? process.arch,
    image_os: process.env.ImageOS ?? 'local',
    image_version: process.env.ImageVersion ?? 'local',
    node: process.version,
    powershell_hosted_workflow: process.env.GITHUB_ACTIONS === 'true',
  },
  attachment_sha256: attachmentSha256,
  workbook_checks: { answer_sheet_names: answerSheets, specification_sheet_names: ['任务规格转化'] },
  clean_runs: cleanRuns,
  positive_mutation: { changed_rule: 'S01的unread_delta从2改为4', exit_code: 0, changed_event_id: 'S01', changed_after: changedS01.after, semantic_digest: mutationRows.digest },
  invalid_input: { removed_input: 'fixtures/agent_roles.json', exit_code: result.code, deliverables_absent: deliverablesAbsent },
  network: { formal_run_network_access: 'loopback only, enforced by Playwright request observer' },
};

await fsp.writeFile(path.join(evidenceRoot, 'windows-verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
