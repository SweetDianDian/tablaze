import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { BrowserError } from './browser.js';

const markerName = '.tablaze-profile.json';
const lockName = '.tablaze-owner-lock';

export interface OwnedProfileLease { directory: string; id: string; release(): Promise<void> }

/** Persistent profiles are explicit, Tablaze-marked directories, never an existing personal Chrome profile. */
export async function acquireOwnedProfile(directory: string, expectedId?: string): Promise<OwnedProfileLease> {
  if (!isAbsolute(directory) || directory === '/' || !directory.trim()) throw new BrowserError('PROFILE_PATH_INVALID', 'profileDir must be a dedicated absolute directory.');
  let created = false;
  try { await mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new BrowserError('PROFILE_PATH_INVALID', 'The profile directory could not be created.'); }
  const info = await lstat(directory).catch(() => { throw new BrowserError('PROFILE_PATH_INVALID', 'The profile directory is unavailable.'); });
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
    throw new BrowserError('PROFILE_PATH_INVALID', 'Use a private directory owned by this user, without group or world access.');
  }
  const lockPath = join(directory, lockName);
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BrowserError('PROFILE_BUSY', 'This Tablaze profile is already locked. Confirm the previous browser is stopped before removing a stale lock.');
    throw new BrowserError('PROFILE_PATH_INVALID', 'The profile directory cannot be locked.');
  }
  const nonce = randomUUID();
  const ownerPath = join(lockPath, 'owner');
  let ownerWritten = false;
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      if (!ownerWritten) { await rmdir(lockPath); return; }
      if (await readFile(ownerPath, 'utf8') !== nonce) return;
      await rm(ownerPath);
      await rmdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  try {
    await writeFile(ownerPath, nonce, { flag: 'wx', mode: 0o600 });
    ownerWritten = true;
    const markerPath = join(directory, markerName);
    const contents = (await readdir(directory)).filter(name => name !== lockName);
    let id: string;
    if (contents.includes(markerName)) {
      const markerInfo = await lstat(markerPath);
      if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 1024) throw new BrowserError('PROFILE_UNOWNED', 'The profile marker is invalid.');
      let marker: unknown;
      try { marker = JSON.parse(await readFile(markerPath, 'utf8')); }
      catch { throw new BrowserError('PROFILE_UNOWNED', 'The profile marker is invalid.'); }
      if (!marker || typeof marker !== 'object' || (marker as any).version !== 1 || typeof (marker as any).id !== 'string' || !/^[0-9a-f-]{36}$/.test((marker as any).id)) throw new BrowserError('PROFILE_UNOWNED', 'The profile marker is invalid.');
      id = (marker as any).id;
      if (!expectedId) throw new BrowserError('PROFILE_ID_REQUIRED', 'Reopening an existing profile requires its expected profile ID.');
      if (expectedId !== id) throw new BrowserError('PROFILE_ID_MISMATCH', 'The configured profile ID does not match this directory.');
    } else {
      if (!created && contents.length) throw new BrowserError('PROFILE_UNOWNED', 'The directory already contains browser data but has no Tablaze marker.');
      if (expectedId) throw new BrowserError('PROFILE_ID_MISMATCH', 'The expected profile does not exist at this path.');
      id = randomUUID();
      await writeFile(markerPath, JSON.stringify({ version: 1, id }) + '\n', { flag: 'wx', mode: 0o600 });
    }
    return { directory, id, release };
  } catch (error) {
    await release();
    throw error;
  }
}
