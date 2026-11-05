import { describe, expect, it } from 'vitest';
import { parseGithubRepo } from './github';

describe('parseGithubRepo', () => {
  it('reads owner and repository from the usual link forms', () => {
    const want = { owner: 'Arnobot-Ind', repo: 'saibya.core' };
    expect(parseGithubRepo('https://github.com/Arnobot-Ind/saibya.core')).toEqual(want);
    expect(parseGithubRepo('https://github.com/Arnobot-Ind/saibya.core/')).toEqual(want);
    expect(parseGithubRepo('https://github.com/Arnobot-Ind/saibya.core.git')).toEqual(want);
    expect(parseGithubRepo('https://www.github.com/Arnobot-Ind/saibya.core/tree/main')).toEqual(want);
  });
  it('refuses anything that is not a github.com repository', () => {
    expect(parseGithubRepo('https://gitlab.com/a/b')).toBeNull();
    expect(parseGithubRepo('https://github.com.evil.example/a/b')).toBeNull();
    expect(parseGithubRepo('https://github.com/only-owner')).toBeNull();
  });
});
