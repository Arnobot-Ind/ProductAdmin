import { describe, expect, it } from 'vitest';
import { fileType } from './storage';

describe('fileType', () => {
  it('sorts files by extension, whatever the folder or letter case', () => {
    expect(fileType('saibya02/Video/cam1/20261010.ts')).toBe('videos');
    expect(fileType('pms-files/products/x/photo.WEBP')).toBe('images');
    expect(fileType('docs/manual.pdf')).toBe('documents');
    expect(fileType('1005/sessions/a/sensors/lidar/1.bin')).toBe('sensors');
    expect(fileType('field/route/dense.ply')).toBe('models');
    expect(fileType('backup.tar.gz')).toBe('archives');
  });
  it('anything else is other', () => {
    expect(fileType('a/session.json')).toBe('other');
    expect(fileType('a/no-extension')).toBe('other');
  });
});
