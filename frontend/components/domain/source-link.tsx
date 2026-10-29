import { ExternalLink, GitCommitHorizontal } from 'lucide-react';

const isUrl = (v: string) => /^https?:\/\/\S+$/i.test(v);
export const isCommitId = (v: string) => /^[0-9a-f]{7,64}$/i.test(v);

/** Where a version was built from: the repository link and the commit (linked to the commit page on GitHub / GitLab). */
export function SourceLink({ repo, commit }: { repo: string | null; commit: string | null }) {
  if (!repo && !commit) return <span className="text-muted">—</span>;
  const commitHref = repo && commit && /github\.com|gitlab\.com/i.test(repo) ? `${repo.replace(/\.git$/, '').replace(/\/$/, '')}/commit/${commit}` : null;
  const host = repo && isUrl(repo) ? new URL(repo).hostname.replace(/^www\./, '') : null;
  return (
    <span className="flex flex-col gap-0.5 text-sm">
      {repo && (
        <a href={repo} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline" title={repo}>
          {host === 'github.com' ? 'GitHub' : (host ?? 'Repository')} <ExternalLink className="size-3.5" aria-hidden />
        </a>
      )}
      {commit &&
        (commitHref ? (
          <a href={commitHref} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-accent-text hover:underline" title={commit}>
            <GitCommitHorizontal className="size-3.5" aria-hidden /> {commit.slice(0, 7)}
          </a>
        ) : (
          <span className="inline-flex items-center gap-1 font-mono" title={commit}>
            <GitCommitHorizontal className="size-3.5" aria-hidden /> {commit.slice(0, 7)}
          </span>
        ))}
    </span>
  );
}
