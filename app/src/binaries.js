import path from 'path';
import getPlatform from './get-platform';

/* eslint-disable import/no-extraneous-dependencies */
const { app } = process.type === 'renderer' ? require('@electron/remote') : require('electron');

const isPackaged = app.getAppPath().includes('app.asar');
const platform = getPlatform();

let binariesPath;
let ffmpegStartPath;
// let platformSpecificFfmpegBinPath;

if (isPackaged) {
  binariesPath = path.join(process.resourcesPath, 'bin');
  ffmpegStartPath = path.join(process.resourcesPath, 'bin');
} else {
  binariesPath = path.join(app.getAppPath(), '..', 'bin');
  ffmpegStartPath = path.join(app.getAppPath(), '..', 'bin');
  // ffmpegStartPath = path.join(app.getAppPath(), '..', 'node_modules/ffmpeg-static');
  // platformSpecificFfmpegBinPath = ffmpegStartPath;
}
const platformSpecificFfmpegBinPath = path.join(ffmpegStartPath, platform);

const platformSpecificBinPath = path.join(binariesPath, platform);

export const segmentationExecutableName = `cadmium-seg${platform === 'win' ? '.exe' : ''}`;
export const ffmpegExecutableName = `ffmpeg${platform === 'win' ? '.exe' : ''}`;
export const cannyLineExecutableName = `edgedetector${platform === 'win' ? '.exe' : ''}`;

/* eslint-disable import/prefer-default-export */
// the quotes are needed when the app contains spaces.
let segmentationExecutablePathArch;
switch (platform) {
  case 'mac':
    switch (process.arch) {
      case 'x64':
        console.log('This is an intel Mac');
        segmentationExecutablePathArch = `"${path.resolve(path.join(platformSpecificBinPath, 'seg', 'x64', segmentationExecutableName))}"`;
        break;
      case 'arm64':
        console.log('This is a Apple Silicon Mac');
        segmentationExecutablePathArch = `"${path.resolve(path.join(platformSpecificBinPath, 'seg', 'arm64', segmentationExecutableName))}"`;
        break;
      default:
        console.log('This architecture is unknown.');
    }
    break;
  case 'win':
    segmentationExecutablePathArch = `"${path.resolve(path.join(platformSpecificBinPath, 'seg', segmentationExecutableName))}"`;
    break;
  default:
    console.log('This computer type is unknown.');
}
export const cannyLineExecutablePath = `"${path.resolve(path.join(platformSpecificBinPath, 'canny', cannyLineExecutableName))}"`;
let ffmpegExecutablePathArch;
switch (platform) {
  case 'mac':
    switch (process.arch) {
      case 'x64':
        ffmpegExecutablePathArch = path.resolve(path.join(platformSpecificFfmpegBinPath, 'x64', ffmpegExecutableName));
        break;
      case 'arm64':
        ffmpegExecutablePathArch = path.resolve(path.join(platformSpecificFfmpegBinPath, 'arm64', ffmpegExecutableName));
        break;
      default:
        ffmpegExecutablePathArch = path.resolve(path.join(platformSpecificFfmpegBinPath, ffmpegExecutableName));
    }
    break;
  default:
    ffmpegExecutablePathArch = path.resolve(path.join(platformSpecificFfmpegBinPath, ffmpegExecutableName));
}

export const ffmpegPath = `${ffmpegExecutablePathArch}`;
export const segmentationExecutablePath = segmentationExecutablePathArch;
// export const ffmpegPath = `${path.resolve(path.join(ffmpegStartPath, ffmpegExecutableName))}`;
