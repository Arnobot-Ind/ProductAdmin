import type { SoftwareLatestDto } from '../shared';
import { ApiError, badRequest } from './errors';

/** Owner and repository from a github.com link; null for any other link. Only api.github.com is ever called. */
export function parseGithubRepo(url: string): { owner: string; repo: string } | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

const unavailable = (message: string) => new ApiError(502, 'github_unavailable', message);

/** The newest version of a repository: its latest release when it has one, else the newest commit on the default branch. */
export async function latestFromGithub(repoUrl: string, token: string | null): Promise<SoftwareLatestDto> {
  const parsed = parseGithubRepo(repoUrl);
  if (!parsed) throw badRequest('Fetching the latest commit works with github.com links only. Check the repository link.');
  const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
  const get = async <T>(path: string): Promise<{ status: number; body: T | null }> => {
    let res: Response;
    try {
      res = await fetch(base + path, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'arnobot-pms',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw unavailable('Could not reach GitHub. Try again in a moment.');
    }
    if (res.status === 401) throw unavailable('GitHub rejected the access token (GITHUB_TOKEN). It may have expired.');
    if (res.status === 403 || res.status === 429) throw unavailable('GitHub refused the request or its hourly limit is used up. Try again later.');
    if (!res.ok && res.status !== 404) throw unavailable(`GitHub answered with an error (${res.status}). Try again later.`);
    return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
  };
  const commit = async (ref: string) => {
    const c = await get<{ sha: string; commit: { message: string; committer: { date: string } | null } }>(`/commits/${encodeURIComponent(ref)}`);
    if (!c.body) throw unavailable(`GitHub has no commit for ${ref}.`);
    return { commit_id: c.body.sha, committed_at: c.body.commit.committer?.date ?? null, message: c.body.commit.message.split('\n')[0].slice(0, 200) };
  };

  const release = await get<{ tag_name: string }>('/releases/latest');
  if (release.body) return { repo_url: repoUrl, version: release.body.tag_name, branch: null, ...(await commit(release.body.tag_name)) };
  const repo = await get<{ default_branch: string }>('');
  if (!repo.body) {
    throw unavailable(token ? 'GitHub cannot find this repository. Check the link, and that the access token can read it.' : 'GitHub cannot find this repository. Check the link. A private repository also needs GITHUB_TOKEN set on the server.');
  }
  return { repo_url: repoUrl, version: null, branch: repo.body.default_branch, ...(await commit(repo.body.default_branch)) };
}
