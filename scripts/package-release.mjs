#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const excludedDirectories = new Set([
  'node_modules', '.git', 'artifacts', 'dist', 'build', 'coverage',
  'test-results', 'playwright-report', '__pycache__', '.cache', '.venv', 'venv',
  '.codex', '.agents', '.openai', '.vercel', '.netlify', '.wrangler',
  '.firebase', '.amplify', '.serverless', '.terraform', '.pulumi', '.hosting',
]);
const excludedFiles = new Set([
  '.DS_Store', '.npmrc', '.firebaserc', 'release-manifest.json',
  'hosting.json', 'hosting.private.json', 'hosting-metadata.json', 'hosting-state.json',
]);
const videoExtensions = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v']);

function usage() {
  return `Usage: node scripts/package-release.mjs [--out /absolute/output/directory]

Build the existing npm package, create a source ZIP, and write SHA-256 evidence.
The default output is artifacts/release beside this repository's package.json.
Requires installed npm dependencies and python3. Nothing is published or uploaded.
The script can be called by absolute path from any working directory.
`;
}

function outputDirectory(args) {
  if (args.length === 0) return path.join(root, 'artifacts', 'release');
  if (args.length !== 2 || args[0] !== '--out' || !path.isAbsolute(args[1])) {
    throw new Error('Use --out followed by one absolute directory path. Run with --help for usage.');
  }
  return assertDedicatedOutput(path.resolve(args[1]));
}

function assertDedicatedOutput(result) {
  const relativeRoot = path.relative(result, root);
  if (relativeRoot === '' || (!relativeRoot.startsWith(`..${path.sep}`) && relativeRoot !== '..' && !path.isAbsolute(relativeRoot))) {
    throw new Error('The output must be a dedicated directory, not the repository root or one of its ancestors.');
  }
  return result;
}

function inside(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function forbidden(relative, { source = true } = {}) {
  const segments = relative.split('/');
  const basename = segments.at(-1);
  if (segments.some((part) => excludedDirectories.has(part) && (source || part !== 'dist'))) return true;
  if (excludedFiles.has(basename) || /^\.env(?:\.|$)/i.test(basename) || /\.env$/i.test(basename)) return true;
  if (/\.(?:tgz|zip)$/i.test(basename) || videoExtensions.has(path.extname(basename).toLowerCase())) return true;
  if (relative === 'demo/output' || relative.startsWith('demo/output/')) return true;
  return false;
}

async function sourceFiles(output) {
  const files = [];
  async function walk(directory, prefix = '') {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (forbidden(relative) || inside(absolute, output)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Source symlinks are not packaged: ${relative}`);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) {
        const details = await lstat(absolute);
        if (path.extname(entry.name).toLowerCase() === '.gif' && details.size > 2 * 1024 * 1024) continue;
        files.push(relative);
      }
    }
  }
  await walk(root);
  files.sort();
  for (const required of ['package.json', 'package-lock.json', 'src/browser.ts', 'tests/browser.test.mjs', 'site/index.html', 'scripts/package-release.mjs', '.github/workflows/ci.yml']) {
    if (!files.includes(required)) throw new Error(`Required source file is missing: ${required}`);
  }
  return files;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}):\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function sha256(data) { return createHash('sha256').update(data).digest('hex'); }

async function artifact(directory, name, kind) {
  const buffer = await readFile(path.join(directory, name));
  return { kind, filename: name, size_bytes: buffer.length, sha256: sha256(buffer) };
}

// Python's standard library provides portable ZIP and tar readers. All values,
// including paths with spaces, arrive as process arguments rather than shell text.
const ARCHIVE_SCRIPT = String.raw`
import hashlib, json, pathlib, stat, sys, tarfile, zipfile

root = pathlib.Path(sys.argv[1]).resolve()
inventory = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'))
zip_path, prefix, tar_path = sys.argv[3:6]
source_size = 0
source_tree = hashlib.sha256()

with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for relative in inventory:
        pure = pathlib.PurePosixPath(relative)
        if pure.is_absolute() or '..' in pure.parts or '\\' in relative:
            raise ValueError('Unsafe source archive path: ' + relative)
        source = root.joinpath(*pure.parts)
        resolved = source.resolve()
        if root not in resolved.parents or source.is_symlink() or not source.is_file():
            raise ValueError('Source is not a regular repository file: ' + relative)
        data = source.read_bytes()
        source_size += len(data)
        source_tree.update(relative.encode('utf-8') + b'\0' + hashlib.sha256(data).digest())
        entry = zipfile.ZipInfo(prefix + '/' + relative, date_time=(1980, 1, 1, 0, 0, 0))
        entry.create_system = 3
        mode = 0o755 if source.stat().st_mode & 0o111 else 0o644
        entry.external_attr = (stat.S_IFREG | mode) << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)

with zipfile.ZipFile(zip_path) as archive:
    bad = archive.testzip()
    if bad is not None:
        raise ValueError('Source ZIP integrity check failed: ' + bad)
    if len(archive.infolist()) != len(inventory):
        raise ValueError('Source ZIP file count mismatch')

dist = []
tar_files = []
with tarfile.open(tar_path, 'r:gz') as archive:
    seen = set()
    for member in archive.getmembers():
        pure = pathlib.PurePosixPath(member.name)
        if pure.is_absolute() or '..' in pure.parts or '\\' in member.name or not pure.parts or pure.parts[0] != 'package':
            raise ValueError('Unsafe npm archive path: ' + member.name)
        if member.isdir():
            continue
        if not member.isfile() or member.name in seen:
            raise ValueError('Unexpected npm archive entry: ' + member.name)
        seen.add(member.name)
        relative = str(pathlib.PurePosixPath(*pure.parts[1:]))
        tar_files.append(relative)
        if relative.startswith('dist/'):
            digest = hashlib.sha256()
            with archive.extractfile(member) as stream:
                for chunk in iter(lambda: stream.read(65536), b''):
                    digest.update(chunk)
            dist.append({'path': relative, 'size_bytes': member.size, 'sha256': digest.hexdigest()})

print(json.dumps({
    'source_file_count': len(inventory),
    'source_size_bytes': source_size,
    'source_tree_sha256': source_tree.hexdigest(),
    'dist': sorted(dist, key=lambda entry: entry['path']),
    'npm_files': sorted(tar_files),
}))
`;

async function main() {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    process.stdout.write(usage());
    return;
  }
  const requestedOutput = outputDirectory(process.argv.slice(2));
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await mkdir(requestedOutput, { recursive: true });
  const output = assertDedicatedOutput(await realpath(requestedOutput));
  const staging = await mkdtemp(path.join(output, '.tablaze-release-'));
  try {
    const npm = process.env.npm_execpath;
    const command = npm ? process.execPath : 'npm';
    const args = [...(npm ? [npm] : []), 'pack', '--json', '--pack-destination', staging];
    const packed = JSON.parse(run(command, args, {
      env: { ...process.env, npm_config_cache: path.join(staging, '.npm-cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' },
    }));
    if (!Array.isArray(packed) || packed.length !== 1) throw new Error('Expected one npm package from npm pack --json.');
    const pack = packed[0];
    if (pack.name !== metadata.name || pack.version !== metadata.version) throw new Error('npm package identity differs from package.json.');
    if (typeof pack.filename !== 'string' || path.basename(pack.filename) !== pack.filename || !pack.filename.endsWith('.tgz')) throw new Error('npm returned an invalid archive filename.');

    const files = await sourceFiles(output);
    const inventory = path.join(staging, 'source-inventory.json');
    await writeFile(inventory, JSON.stringify(files));
    const prefix = pack.filename.slice(0, -4);
    const zipName = `${prefix}-source.zip`;
    const details = JSON.parse(run('python3', ['-c', ARCHIVE_SCRIPT, root, inventory, path.join(staging, zipName), prefix, path.join(staging, pack.filename)]));
    for (const name of details.npm_files) {
      if (forbidden(name, { source: false })) throw new Error(`The npm manifest includes an excluded release file: ${name}`);
    }
    if (!details.dist.length) throw new Error('The npm package does not contain compiled dist files.');
    for (const entry of details.dist) {
      const current = await readFile(path.join(root, entry.path));
      if (sha256(current) !== entry.sha256) throw new Error(`Compiled file changed after npm pack: ${entry.path}. Run packaging again.`);
    }
    const archives = await Promise.all([
      artifact(staging, pack.filename, 'npm_package'),
      artifact(staging, zipName, 'source_zip'),
    ]);
    archives[0].file_count = details.npm_files.length;
    archives[1].file_count = details.source_file_count;
    const manifest = {
      schema_version: 1,
      created_at: new Date().toISOString(),
      package: { name: metadata.name, version: metadata.version },
      artifacts: archives,
      source_file_count: details.source_file_count,
      source_uncompressed_size_bytes: details.source_size_bytes,
      source_tree_sha256: details.source_tree_sha256,
      source_archive_root: `${prefix}/`,
      dist: details.dist,
      source_exclusions: {
        directories: [...excludedDirectories].sort(),
        filenames: [...excludedFiles].sort(),
        patterns: ['.env', '.env.*', '*.env', '*.tgz', '*.zip', 'demo/output/**', ...[...videoExtensions].sort().map((extension) => `*${extension}`), '*.gif larger than 2 MiB'],
      },
    };
    await writeFile(path.join(staging, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const entry of archives) await rename(path.join(staging, entry.filename), path.join(output, entry.filename));
    // Commit the manifest last so it describes only finished artifacts.
    await rename(path.join(staging, 'release-manifest.json'), path.join(output, 'release-manifest.json'));
    process.stdout.write(`${JSON.stringify({ output_directory: output, ...manifest }, null, 2)}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`Release packaging failed: ${error.message}\n`);
  process.exitCode = 1;
});
