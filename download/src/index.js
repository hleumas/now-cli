/* eslint-disable unicorn/no-process-exit */

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import zlib from 'zlib';
import onDeath from 'death';
import fetch from 'node-fetch';
import retry from 'async-retry';
import which from 'which-promise';
import readPkg from 'read-pkg';
import plusxSync from './chmod';
import {
  disableProgress,
  enableProgress,
  info,
  showProgress,
  warn
} from './log';
import packageJSON from '../../package';

fetch.Promise = Promise;
global.Promise = Promise;
let { platform } = process;
if (detectAlpine()) platform = 'alpine';

const now = path.join(__dirname, 'now');
const targetWin32 = path.join(__dirname, 'now.exe');
const target = platform === 'win32' ? targetWin32 : now;
const partial = target + '.partial';

const platformToName = {
  alpine: 'now-alpine',
  darwin: 'now-macos',
  linux: 'now-linux',
  win32: 'now-win.exe'
};

function detectAlpine() {
  if (platform !== 'linux') return false;
  // https://github.com/sass/node-sass/issues/1589#issuecomment-265292579
  const ldd = spawnSync('ldd', [process.execPath]).stdout.toString();
  return /\bmusl\b/.test(ldd);
}

async function download() {
  try {
    fs.writeFileSync(
      now,
      '#!/usr/bin/env node\n' +
        'console.log("Please wait until the \'now\' installation completes!")\n'
    );
  } catch (err) {
    if (err.code === 'EACCES') {
      warn(
        'Please try installing Now CLI again with the `--unsafe-perm` option.'
      );
      info('Example: `npm i -g --unsafe-perm now`');

      process.exit();
    }

    throw err;
  }

  onDeath(() => {
    fs.writeFileSync(
      now,
      '#!/usr/bin/env node\n' +
        'console.log("The \'now\' installation did not complete successfully.")\n' +
        'console.log("Please run \'npm i -g now\' to reinstall!")\n'
    );
    process.exit();
  });

  info('For the source code, check out: https://github.com/zeit/now-cli');

  // Print an empty line
  console.log('');

  await retry(
    async () => {
      enableProgress('Downloading Now CLI ' + packageJSON.version);
      showProgress(0);

      try {
        const name = platformToName[platform];
        const url = `https://github.com/zeit/now-cli/releases/download/${packageJSON.version}/${name}.gz`;
        const resp = await fetch(url, { compress: false });

        if (resp.status !== 200) {
          throw new Error(resp.statusText + ' ' + url);
        }

        const size = resp.headers.get('content-length');
        const ws = fs.createWriteStream(partial);

        await new Promise((resolve, reject) => {
          let bytesRead = 0;

          resp.body.on('error', reject).on('data', chunk => {
            bytesRead += chunk.length;

            if (size) {
              showProgress(100 * bytesRead / size);
            }
          });

          const gunzip = zlib.createGunzip();

          gunzip.on('error', reject);

          resp.body.pipe(gunzip).pipe(ws);

          ws.on('error', reject).on('close', () => {
            showProgress(100);
            resolve();
          });
        });
      } finally {
        disableProgress();
      }
    },
    {
      retries: 10,
      onRetry: err => console.error(err)
    }
  );

  fs.renameSync(partial, target);
}

function modifyGitBashFile(content) {
  const initContent = (
    '#!/bin/sh\n' +
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n' +
    '\n' +
    'case `uname` in\n' +
    '    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;\n' +
    'esac\n' +
    '\n'
  );

  // Older files could contain this multiple times
  // since it just got appended every time
  if (content.split(initContent).length > 2) {
    const defaultContent = content
      .replace(new RegExp(initContent, 'g'), '')
      .replace('download/dist/now"', 'download/dist/now.exe"')
      .trim();

    return initContent + defaultContent;
  }

  if (content.startsWith(initContent)) {
    return content.replace('download/dist/now"', 'download/dist/now.exe"');
  }

  return (
    initContent +
    content.replace('download/dist/now"', 'download/dist/now.exe"')
  );
}

async function main() {
  await download();

  if (platform === 'win32') {
    try {
      fs.writeFileSync(now, '');
      // Workaround for https://github.com/npm/cmd-shim/pull/25
      const globalPath = path.dirname(await which('npm'));
      let gitBashFile = path.join(globalPath, 'now');
      if (!fs.existsSync(gitBashFile)) {
        gitBashFile = path.join(process.env.APPDATA, 'npm/now');
      }

      fs.writeFileSync(
        gitBashFile,
        modifyGitBashFile(fs.readFileSync(gitBashFile, 'utf8'))
      );

      let npmCmdFile = path.join(globalPath, 'now.cmd');
      if (!fs.existsSync(npmCmdFile)) {
        npmCmdFile = path.join(process.env.APPDATA, 'npm/now.cmd');
      }

      fs.writeFileSync(
        npmCmdFile,
        '@\"%~dp0node_modules\\now\\download\\dist\\now.exe\" %*'
      );
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Not a problem. only git cmd will not work
        console.error(err);
      }
    }
  } else {
    plusxSync(now);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(2);
});
