import { describe, expect, test } from 'bun:test';
import { resolveProjectForSessionDirectory } from './projectResolution';

const projects = [
  { id: 'zedcode', path: '/workspace/zedcode', label: 'ZedCode' },
];

describe('resolveProjectForSessionDirectory', () => {
  test('resolves a sibling worktree to its registered project', () => {
    const worktrees = new Map([
      ['/workspace/zedcode', [{
        path: '/workspace/zedcode-feature',
        projectDirectory: '/workspace/zedcode',
        branch: 'feature',
        label: 'feature',
      }]],
    ]);

    expect(resolveProjectForSessionDirectory(projects, worktrees, '/workspace/zedcode-feature')).toEqual(projects[0]);
  });
});
