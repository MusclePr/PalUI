#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!['--template', '--destination', '--host-server-dir'].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}`);
    }
    options[name] = value;
    index += 1;
  }

  if (!options['--template'] || !options['--destination']) {
    throw new Error('Usage: bootstrap-server.mjs --template DIR --destination DIR [--host-server-dir DIR]');
  }
  return options;
}

function decodeMountField(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function getContainerHostServerDir() {
  const mountInfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const mount = mountInfo
    .split('\n')
    .map((line) => line.split(' '))
    .find((fields) => fields[4] === '/server');

  if (!mount || !mount[3]) {
    throw new Error('Could not find the /server bind mount in /proc/self/mountinfo');
  }

  const hostServerDir = decodeMountField(mount[3]);
  if (!path.isAbsolute(hostServerDir)) {
    throw new Error(`The /server mount source is not an absolute path: ${hostServerDir}`);
  }
  return hostServerDir;
}

function setOwner(target, uid, gid) {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    fs.chownSync(target, uid, gid);
  }
}

function copyMissing(source, destination, uid, gid) {
  const sourceStat = fs.lstatSync(source);
  let destinationStat;
  try {
    destinationStat = fs.lstatSync(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (destinationStat) {
    if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
      for (const name of fs.readdirSync(source)) {
        copyMissing(path.join(source, name), path.join(destination, name), uid, gid);
      }
    }
    return;
  }

  if (sourceStat.isDirectory()) {
    fs.mkdirSync(destination, { mode: sourceStat.mode & 0o777 });
    setOwner(destination, uid, gid);
    for (const name of fs.readdirSync(source)) {
      copyMissing(path.join(source, name), path.join(destination, name), uid, gid);
    }
    fs.chmodSync(destination, sourceStat.mode & 0o777);
    return;
  }

  if (sourceStat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Unsupported template entry: ${source}`);
  }

  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, sourceStat.mode & 0o777);
  setOwner(destination, uid, gid);
  fs.utimesSync(destination, sourceStat.atime, sourceStat.mtime);
}

function parseId(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

function getProjectName() {
  const name = process.env.COMPOSE_PROJECT_NAME || `${process.env.PROJECT || 'dev'}_pal`;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error(`Invalid Compose project name: ${name}`);
  }
  return name;
}

function renderCompose(templatePath, destination, hostServerDir, uid, gid) {
  const template = fs.readFileSync(templatePath, 'utf8');
  const placeholder = '__HOST_SERVER_DIR__';
  if (!template.includes(placeholder)) {
    throw new Error(`Compose template does not contain ${placeholder}`);
  }
  const projectPlaceholder = '__PROJECT_PAL__';
  if (!template.includes(projectPlaceholder)) {
    throw new Error(`Compose template does not contain ${projectPlaceholder}`);
  }

  const composeSource = `${hostServerDir.replaceAll('$', '$$')}/palworld`;
  const rendered = template
    .replaceAll(placeholder, JSON.stringify(composeSource))
    .replaceAll(projectPlaceholder, JSON.stringify(getProjectName()));
  for (const remainingPlaceholder of [placeholder, projectPlaceholder]) {
    if (rendered.includes(remainingPlaceholder)) {
      throw new Error(`Compose template still contains ${remainingPlaceholder} after rendering`);
    }
  }

  const composePath = path.join(destination, 'compose.yml');
  const temporaryPath = path.join(destination, `.compose.yml.${process.pid}.${Date.now()}.tmp`);
  const output = `# Generated from template.compose.yml at startup; local edits are overwritten.\n${rendered}`;

  try {
    fs.writeFileSync(temporaryPath, output, { flag: 'wx', mode: 0o644 });
    fs.chmodSync(temporaryPath, 0o644);
    setOwner(temporaryPath, uid, gid);
    fs.renameSync(temporaryPath, composePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const template = path.resolve(options['--template']);
  const destination = path.resolve(options['--destination']);

  if (!fs.statSync(template).isDirectory()) {
    throw new Error(`Template directory does not exist: ${template}`);
  }
  fs.mkdirSync(destination, { recursive: true });

  const fallbackUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const fallbackGid = typeof process.getgid === 'function' ? process.getgid() : 0;
  const uid = parseId('PUID', fallbackUid);
  const gid = parseId('PGID', fallbackGid);

  for (const name of fs.readdirSync(template)) {
    copyMissing(path.join(template, name), path.join(destination, name), uid, gid);
  }

  const hostServerDir = options['--host-server-dir']
    ? fs.realpathSync(options['--host-server-dir'])
    : getContainerHostServerDir();
  if (!path.isAbsolute(hostServerDir)) {
    throw new Error(`Host server directory is not absolute: ${hostServerDir}`);
  }

  renderCompose(path.join(destination, 'template.compose.yml'), destination, hostServerDir, uid, gid);
}

try {
  main();
} catch (error) {
  console.error(`Server initialization failed: ${error.message}`);
  process.exitCode = 1;
}