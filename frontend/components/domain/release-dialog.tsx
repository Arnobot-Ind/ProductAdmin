'use client';

import type { ReleaseComponent, ReleaseDto } from '@arnobot/message-schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileCheck2, Loader2, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { isCommitId } from '@/components/domain/source-link';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { InlineAlert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { fmtBytes } from '@/lib/format';
import { useProducts } from '@/lib/queries';
import { RELEASE_COMPONENTS } from '@/lib/schema';

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/i;
/** Packages up to this size get their SHA-256 shown before upload (computed in the browser). */
const HASH_IN_BROWSER_MAX = 512 * 1024 * 1024;
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);
/** "v1.4.0" (a Git tag) and "1.4.0" are the same version. */
const cleanVersion = (v: string) => v.trim().replace(/^v(?=\d)/i, '');

/** Compares two semantic versions by major.minor.patch (a pre-release suffix counts lower). */
function cmpSemver(a: string, b: string): number {
  const [x, xs] = a.split(/[-+]/, 2);
  const [y, ys] = b.split(/[-+]/, 2);
  const p = x.split('.').map(Number);
  const q = y.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] - q[i];
  return xs === ys ? 0 : xs ? -1 : ys ? 1 : 0;
}
/** The next patch, minor and major after `v`. */
function nextVersions(v: string): string[] {
  const [ma, mi, pa] = v.split(/[-+]/)[0].split('.').map(Number);
  return [`${ma}.${mi}.${pa + 1}`, `${ma}.${mi + 1}.0`, `${ma + 1}.0.0`];
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A signature file: kept as is when it is already base64 text, else its bytes are base64-encoded. */
async function readSignature(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
  if (/^[A-Za-z0-9+/=\s-]+$/.test(text) && text.length > 0) return text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

type Errors = Partial<Record<'product' | 'version' | 'requires' | 'package' | 'sha' | 'signature' | 'repo' | 'commit', string>>;

/**
 * Register a release: which base model and component, which version (with the latest one shown and the next ones
 * one click away), the package (its checksum shown before upload), the Arnobot signature (pasted or loaded from
 * its .sig file), where it was built from, what it needs, and what changed. Every problem is shown at its field.
 */
export function RegisterReleaseDialog({ onClose }: { onClose: () => void }) {
  const products = useProducts();
  const qc = useQueryClient();
  const toast = useToast();
  const [productId, setProductId] = useState('');
  const [component, setComponent] = useState<ReleaseComponent>('software');
  const [version, setVersion] = useState('');
  const [requiresMin, setRequiresMin] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileSha, setFileSha] = useState<string | null>(null);
  const [hashing, setHashing] = useState(false);
  const [sha, setSha] = useState('');
  const [signature, setSignature] = useState('');
  const [algo, setAlgo] = useState('ed25519');
  const [repo, setRepo] = useState('');
  const [commit, setCommit] = useState('');
  const [notes, setNotes] = useState('');
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sigInput = useRef<HTMLInputElement>(null);
  const other: ReleaseComponent = component === 'software' ? 'firmware' : 'software';

  const product = products.data?.find((p) => p.id === productId);
  // Every version of this base model, deleted ones included: a version number is never reused.
  const existing = useQuery({
    queryKey: ['releases', { productId, component: '', includeDeleted: true }],
    queryFn: () => api.get<ReleaseDto[]>('/releases', { product_id: productId, include_deleted: true }),
    enabled: !!productId,
  });
  const ofComponent = (existing.data ?? []).filter((r) => r.component === component);
  const latest = ofComponent.filter((r) => !r.deleted_at).sort((a, b) => cmpSemver(b.version, a.version))[0];
  const latestOther = (existing.data ?? []).filter((r) => r.component === other && !r.deleted_at).sort((a, b) => cmpSemver(b.version, a.version))[0];

  // The checksum of the chosen package, so it can be compared with the build output before uploading.
  useEffect(() => {
    setFileSha(null);
    if (!file || file.size > HASH_IN_BROWSER_MAX || !crypto?.subtle) return;
    let live = true;
    setHashing(true);
    sha256Hex(file)
      .then((h) => live && setFileSha(h))
      .catch(() => undefined)
      .finally(() => live && setHashing(false));
    return () => {
      live = false;
    };
  }, [file]);

  const v = cleanVersion(version);
  const errors: Errors = {};
  if (!productId) errors.product = 'Choose the base model this release is for';
  if (!v) errors.version = 'Enter the version, e.g. 1.4.0';
  else if (!SEMVER.test(v)) errors.version = 'Use three numbers: major.minor.patch, e.g. 1.4.0';
  else if (ofComponent.some((r) => r.version === v)) errors.version = `${v} is already used for this ${component}${ofComponent.find((r) => r.version === v)?.deleted_at ? ' (deleted, but numbers are never reused)' : ''}`;
  if (requiresMin.trim() && !SEMVER.test(cleanVersion(requiresMin))) errors.requires = 'Use three numbers, e.g. 0.9.0';
  if (!file && !sha.trim()) errors.package = 'Choose the package file (or, without a file, enter its SHA-256 below)';
  if (sha.trim() && !SHA256.test(sha.trim())) errors.sha = 'A SHA-256 is 64 characters 0–9 and a–f';
  else if (sha.trim() && fileSha && sha.trim().toLowerCase() !== fileSha) errors.sha = 'Does not match the chosen package';
  if (!signature.trim()) errors.signature = 'Paste the Arnobot signature, or load its .sig file';
  if (repo.trim() && !/^https?:\/\/\S+$/i.test(repo.trim())) errors.repo = 'A web link starting with https://';
  if (commit.trim() && !isCommitId(commit.trim())) errors.commit = '7–64 characters 0–9 and a–f, e.g. 3f9c2ab';
  const shown = (k: keyof Errors) => (tried ? (errors[k] ?? null) : null);
  const count = Object.keys(errors).length;

  const m = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.set('product_id', productId);
      fd.set('component', component);
      fd.set('version', v);
      fd.set('signature', signature.trim());
      if (algo.trim()) fd.set('signature_algo', algo.trim());
      if (sha.trim()) fd.set('sha256', sha.trim().toLowerCase());
      if (requiresMin.trim()) {
        fd.set('requires_component', other);
        fd.set('requires_min_version', cleanVersion(requiresMin));
      }
      if (notes.trim()) fd.set('notes', notes.trim());
      if (repo.trim()) fd.set('repo_url', repo.trim());
      if (commit.trim()) fd.set('commit_id', commit.trim().toLowerCase());
      if (file) fd.set('file', file);
      return api.upload<ReleaseDto>('/releases', fd);
    },
    onSuccess: (r) => {
      toast.success(`Registered ${product?.name ?? r.product_code} ${r.component} ${r.version}`);
      void qc.invalidateQueries({ queryKey: ['releases'] });
      onClose();
    },
    onError: (e) => setServerError(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    setServerError(null);
    if (count) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('#release-form [aria-invalid="true"]')?.focus());
      return;
    }
    m.mutate();
  };

  /** A pasted GitHub commit link fills the commit; a tag / release link fills the version when empty. */
  const onRepo = (value: string) => {
    const c = value.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/commit\/([0-9a-f]{7,64})/i);
    if (c) {
      setRepo(c[1]);
      setCommit(c[2]);
      return;
    }
    const t = value.match(/^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/(?:releases\/tag|tree)\/v?(\d+\.\d+\.\d+[^/?#]*)/i);
    if (t && !version.trim()) setVersion(t[2]);
    setRepo(value);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Register release"
      description="One release = one version of a base model's software or firmware. The robot installs it only if the package matches its SHA-256 and the Arnobot signature."
      footer={
        <>
          {tried && count > 0 && (
            <span className="mr-auto text-sm font-medium text-fault">
              {count} field{count === 1 ? '' : 's'} to fix
            </span>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="release-form" loading={m.isPending}>
            Register
          </Button>
        </>
      }
    >
      <form id="release-form" onSubmit={submit} className="flex flex-col gap-6" noValidate>
        <Group title="What">
          <Field label="Base model" required error={shown('product')}>
            <Select
              value={productId}
              onChange={(e) => {
                const next = products.data?.find((p) => p.id === e.target.value);
                // Follow the base model's repository unless a different one was typed in.
                if (!repo.trim() || repo.trim() === (product?.repo_url ?? '')) setRepo(next?.repo_url ?? '');
                setProductId(e.target.value);
              }}
              data-autofocus
            >
              <option value="">Choose…</option>
              {(['ugv', 'uav'] as const).map((cat) => (
                <optgroup key={cat} label={cat.toUpperCase()}>
                  {products.data
                    ?.filter((p) => !p.deleted_at && p.category === cat)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Component" required hint={component === 'software' ? 'Navigation, cameras, maps, cloud sync …' : 'Motors, battery, sensors (controller boards)'}>
            <Select value={component} onChange={(e) => setComponent(e.target.value as ReleaseComponent)}>
              {RELEASE_COMPONENTS.map((c) => (
                <option key={c} value={c}>
                  {capital(c)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field
              label="Version"
              required
              error={shown('version')}
              hint={
                !productId
                  ? 'major.minor.patch, e.g. 1.4.0 (a Git tag like v1.4.0 is fine)'
                  : existing.isLoading
                    ? 'Checking earlier versions…'
                    : latest
                      ? `Latest ${component} of ${product?.name}: ${latest.version}`
                      : `First ${component} release of ${product?.name}`
              }
            >
              <Input value={version} onChange={(e) => setVersion(e.target.value)} className="font-mono" placeholder="1.4.0" spellCheck={false} />
            </Field>
            {latest && (
              <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
                Next:
                {nextVersions(latest.version).map((n, i) => (
                  <button key={n} type="button" onClick={() => setVersion(n)} className="rounded-md border border-border px-2 py-0.5 font-mono text-fg hover:border-accent hover:text-accent-text">
                    {n} <span className="font-sans text-xs text-muted">{['fix', 'feature', 'major'][i]}</span>
                  </button>
                ))}
              </p>
            )}
          </div>
        </Group>

        <Group title="Package">
          <div className="sm:col-span-2">
            <Field label="Update package" required={!sha.trim()} error={shown('package')}>
              <input ref={fileInput} type="file" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-invalid={shown('package') ? true : undefined} />
            </Field>
            {file ? (
              <div className="mt-1 flex items-start gap-3 rounded-lg border border-border bg-surface-2 p-3">
                <FileCheck2 className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{file.name}</span>
                  <span className="block text-sm text-muted">{fmtBytes(file.size)}</span>
                  <span className="mt-1 block font-mono text-xs break-all text-muted">
                    {hashing ? (
                      <span className="inline-flex items-center gap-1">
                        <Loader2 className="size-3 animate-spin" aria-hidden /> Computing SHA-256…
                      </span>
                    ) : fileSha ? (
                      `SHA-256 ${fileSha}`
                    ) : (
                      'The server computes the SHA-256 on upload.'
                    )}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setFile(null);
                    if (fileInput.current) fileInput.current.value = '';
                  }}
                  aria-label="Remove the package"
                  className="rounded-md p-1 text-muted hover:bg-surface hover:text-fg"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            ) : (
              <Button className="mt-1" icon={<Upload className="size-4" aria-hidden />} onClick={() => fileInput.current?.click()}>
                Choose package file
              </Button>
            )}
          </div>
          <Field
            label={file ? 'SHA-256 to check against (optional)' : 'SHA-256 (when there is no package file)'}
            error={shown('sha')}
            hint={file ? 'Paste the checksum from the build to make sure the right file is uploaded.' : 'Only when the package is stored elsewhere.'}
            className="sm:col-span-2"
          >
            <Input value={sha} onChange={(e) => setSha(e.target.value)} className="font-mono" spellCheck={false} placeholder="64 characters 0–9, a–f" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Arnobot signature" required error={shown('signature')} hint="Base64 signature of the package, from the signing step of the build.">
              <Textarea rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} className="font-mono text-sm" spellCheck={false} placeholder="Paste it, or load the .sig file" />
            </Field>
            <input
              ref={sigInput}
              type="file"
              accept=".sig,.asc,.b64,.txt,application/octet-stream"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) setSignature(await readSignature(f));
              }}
            />
            <Button size="sm" className="mt-2" icon={<Upload className="size-4" aria-hidden />} onClick={() => sigInput.current?.click()}>
              Load .sig file
            </Button>
          </div>
          <Field label="Signature algorithm">
            <Select value={algo} onChange={(e) => setAlgo(e.target.value)}>
              {['ed25519', 'ecdsa-p256', 'rsa-pss-sha256'].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </Field>
        </Group>

        <Group title="Source (optional)">
          <Field label="GitHub link" error={shown('repo')} hint="Repository, tag or commit link. A commit link fills in the commit ID.">
            <Input value={repo} onChange={(e) => onRepo(e.target.value)} placeholder="https://github.com/…" spellCheck={false} />
          </Field>
          <Field label="Commit ID" error={shown('commit')} hint="Short or full, e.g. 3f9c2ab">
            <Input value={commit} onChange={(e) => setCommit(e.target.value)} className="font-mono" spellCheck={false} />
          </Field>
        </Group>

        <Group title="Needs (optional)">
          <Field
            label={`Minimum ${other} version`}
            error={shown('requires')}
            hint={`Robots install this only when their ${other} is at least this version${latestOther ? ` (latest ${other}: ${latestOther.version})` : ''}.`}
          >
            <Input value={requiresMin} onChange={(e) => setRequiresMin(e.target.value)} className="font-mono" placeholder="e.g. 0.9.0" spellCheck={false} />
          </Field>
        </Group>

        <Group title="What changed">
          <Field label="Release notes" className="sm:col-span-2">
            <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} placeholder={'New: …\nFixed: …'} />
          </Field>
        </Group>

        {serverError && <InlineAlert tone="fault">{serverError}</InlineAlert>}
      </form>
    </Dialog>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="mb-3 text-sm font-semibold tracking-wide text-muted uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}
