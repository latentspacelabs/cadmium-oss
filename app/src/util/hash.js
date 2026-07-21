import SparkMD5 from 'spark-md5';

/* eslint-disable import/prefer-default-export */
export function getHash(s) {
  if (!s) { return null; }
  return SparkMD5.hash(s);
}
