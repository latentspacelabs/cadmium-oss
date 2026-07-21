import spawn from 'await-spawn';
import { logError } from './util/error-util';
import {
  checkpointIndexPath,
  serverExecutablePath,
  serverExecutableName,
} from './binaries';

const find = require('find-process');

export const localhostServerPort = 5000;
export const localhostServerBaseUrl = `http://localhost:${localhostServerPort}`;
export const localhostServerColorizeUrl = `${localhostServerBaseUrl}/colorize`;
export const localhostServerAAUrl = `${localhostServerBaseUrl}/preprocess`;

/**
 * Starts the colorization server if it is not already running
 */
export async function startServer() {
  console.log('Starting server ...');

  /* eslint-disable no-use-before-define */
  const isRunning = await serverIsRunning();
  if (!isRunning) {
  // if it is not already running, start it
    const args = [
      '--saved_model_path',
      checkpointIndexPath,
    ];
    console.log('About to start server with args: ', args);
    const spawnPromise = spawn(serverExecutablePath, args, { shell: true });
    const stdOutBuf = await spawnPromise;
    console.log('Server start: ---------------------------');
    console.log(stdOutBuf.toString());
    // spawnPromise.child.pid is PID
  }
}

/**
 * Stops all processes with the name of the colorization process
 */
export async function stopServer() {
  // there can be more than one process with this name, kill them all
  // see https://www.npmjs.com/package/find-process for serverProcess data type

  /* eslint-disable no-restricted-syntax */
  // Iterate over the property names:
  const serverProcesses = await find('name', serverExecutableName);
  console.log('Stopping server ...');
  for (const p of serverProcesses) {
    console.log(`About to kill process with ID: ${p.pid}`);
    process.kill(p.pid);
  }
}

/**
 * Checks if the cadmium server with name "cadmium-server" is currently running
 * @returns {boolean} - true if server is running, false otherwise
 */
async function serverIsRunning() {
  try {
    const serverProcesses = await find('name', serverExecutableName);
    // console.log('serverProcesses: ', serverProcesses);
    if (serverProcesses.length === 0) {
      return false;
    } if (serverProcesses.length === 1) {
      return true;
    } // more than one servers running (-> should be fixed)
    logError(null, 'More than one cadmium servers is running simultaneously!');
    return true;
  } catch (err) {
    logError(err, 'Could not search for existing colorization server process.');
    return false;
  }
}
