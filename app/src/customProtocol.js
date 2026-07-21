/**
 * Custom protocol handler with proper MIME type support for fonts.
 * 
 * Fixes two issues with vue-cli-plugin-electron-builder's default createProtocol:
 * 1. URL normalization: Chromium converts app:///fonts/file.woff2 to app://fonts/file.woff2
 *    treating 'fonts' as hostname instead of path. We handle this by prepending the host to the path.
 * 2. Missing font MIME types: The default handler doesn't set MIME types for .woff, .woff2, .ttf, etc.
 */
import { protocol } from 'electron';
import * as path from 'path';
import { readFile } from 'fs';
import { URL } from 'url';

export default function createProtocol(scheme, customProtocol) {
  (customProtocol || protocol).registerBufferProtocol(
    scheme,
    (request, respond) => {
      const parsedUrl = new URL(request.url);
      
      // Handle URL normalization issue where app:///fonts/file.woff2 becomes app://fonts/file.woff2
      // In the latter case, 'fonts' is parsed as the hostname instead of part of the path
      let pathName = parsedUrl.pathname;
      
      // If the host is not empty or '.', it's actually part of the path
      const host = parsedUrl.host;
      if (host && host !== '.') {
        pathName = '/' + host + pathName;
      }
      
      pathName = decodeURI(pathName); // Needed in case URL contains spaces

      const filePath = path.join(__dirname, pathName);

      readFile(filePath, (error, data) => {
        if (error) {
          console.error(`Failed to read ${pathName} on ${scheme} protocol`, error);
        }
        
        const extension = path.extname(pathName).toLowerCase();
        let mimeType = '';

        // Standard MIME types
        if (extension === '.js') {
          mimeType = 'text/javascript';
        } else if (extension === '.html') {
          mimeType = 'text/html';
        } else if (extension === '.css') {
          mimeType = 'text/css';
        } else if (extension === '.svg' || extension === '.svgz') {
          mimeType = 'image/svg+xml';
        } else if (extension === '.json') {
          mimeType = 'application/json';
        } else if (extension === '.wasm') {
          mimeType = 'application/wasm';
        }
        // Font MIME types (required for @font-face)
        else if (extension === '.woff') {
          mimeType = 'font/woff';
        } else if (extension === '.woff2') {
          mimeType = 'font/woff2';
        } else if (extension === '.ttf') {
          mimeType = 'font/ttf';
        } else if (extension === '.otf') {
          mimeType = 'font/otf';
        } else if (extension === '.eot') {
          mimeType = 'application/vnd.ms-fontobject';
        }
        // Image MIME types
        else if (extension === '.png') {
          mimeType = 'image/png';
        } else if (extension === '.jpg' || extension === '.jpeg') {
          mimeType = 'image/jpeg';
        } else if (extension === '.gif') {
          mimeType = 'image/gif';
        } else if (extension === '.webp') {
          mimeType = 'image/webp';
        } else if (extension === '.ico' || extension === '.cur') {
          mimeType = 'image/x-icon';
        }

        respond({ mimeType, data });
      });
    }
  );
}
