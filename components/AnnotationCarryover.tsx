'use client';

import { useEffect, useRef, useState } from 'react';
import { buildReport, carryOver, summarize, writeAnnotations } from '@/lib/core';
import type { AnnotationRecord, DocIndex, Options, PdfDocument, PdfLib } from '@/lib/core';
import { installCharMeasurer, loadPdfLib, openPdf } from '@/lib/loaders';
import ReviewPanel from './ReviewPanel';
import type { RenderableDoc } from './PdfPageView';

type Phase = 'upload' | 'review' | 'save';
const STEPS: { id: Phase; label: string }[] = [
  { id: 'upload', label: 'Choose' },
  { id: 'review', label: 'Review' },
  { id: 'save', label: 'Save' },
];

interface Session {
  oldDoc: PdfDocument;
  newDoc: PdfDocument;
  newBytes: Uint8Array;
  pdfLib: PdfLib;
  index: DocIndex;
  options: Options;
  oldName: string;
  newName: string;
}

function errorMessage(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  const msg = e?.message ?? String(err);
  if (e?.name === 'PasswordException') return 'One of the PDFs is protected with a password.';
  if (e?.name === 'InvalidPDFException') return 'One of the files is not a valid PDF.';
  if (/encrypt/i.test(msg)) return 'The new PDF is encrypted and cannot be modified.';
  return msg;
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const baseName = (n: string): string => n.replace(/\.pdf$/i, '');

const formatSize = (bytes: number): string =>
  bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;

function readFile(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error(`Could not read ${file.name}.`));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}.`));
    reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled.`));
    reader.readAsArrayBuffer(file);
  });
}

function Picker(props: {
  step: number; title: string; placeholder: string; file: File | null; onPick: (f: File | null) => void;
}) {
  const { step, title, placeholder, file, onPick } = props;
  return (
    <label className={`pick${file ? ' done' : ''}`}>
      <span className="step">{step}</span>
      <span className="txt">
        <strong>{title}</strong>
        <small>{file ? `${file.name} (${formatSize(file.size)})` : placeholder}</small>
      </span>
      <input
        type="file"
        accept="application/pdf,.pdf"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        onInput={(e) => onPick(e.currentTarget.files?.[0] ?? null)}
      />
    </label>
  );
}

export default function AnnotationCarryover() {
  const [oldFile, setOldFile] = useState<File | null>(null);
  const [newFile, setNewFile] = useState<File | null>(null);
  const [flagChanged, setFlagChanged] = useState(true);
  const [minSimilarity, setMinSimilarity] = useState(0.7);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ text: string; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [results, setResults] = useState<AnnotationRecord[]>([]);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [phase, setPhase] = useState<Phase>('upload');
  const topRef = useRef<HTMLDivElement | null>(null);

  const ready = !!oldFile && !!newFile && !busy;

  function goTo(next: Phase) {
    setPhase(next);
    window.scrollTo({ top: 0 });
  }

  /** Return to start for a new document. */
  function startOver() {
    setOldFile(null);
    setNewFile(null);
    setSession(null);
    setResults([]);
    setBytes(null);
    setError(null);
    goTo('upload');
  }

  async function run() {
    if (!oldFile || !newFile) return;
    setError(null);
    setSession(null);
    setResults([]);
    setBytes(null);
    setBusy(true);
    setProgress({ text: 'Opening files', fraction: 0.02 });
    try {
      installCharMeasurer();
      const [pdfLib, oldBytes, newBytes] = await Promise.all([
        loadPdfLib(),
        readFile(oldFile),
        readFile(newFile),
      ]);
      const oldDoc = await openPdf(oldBytes);
      const newDoc = await openPdf(newBytes);
      const options = { minSimilarity, flagChanged };
      const res = await carryOver({
        oldDoc, newDoc, newBytes, pdfLib, options,
        write: false, // we only want the results, not the output yet
        onProgress: (text, fraction) => setProgress({ text, fraction }),
      });
      if (!res.results.length || !res.index) {
        setError('No annotations were found in the old PDF.');
      } else {
        setSession({
          oldDoc, newDoc, newBytes, pdfLib, index: res.index, options: res.options,
          oldName: oldFile.name, newName: newFile.name,
        });
        setResults(res.results);
        goTo(res.results.some((r) => r.status !== 'exact') ? 'review' : 'save');
      }
    } catch (err) {
      console.error(err);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // Output the new PDF with annotations once we have a session and results.
  useEffect(() => {
    if (!session || !results.length) return;
    let stale = false;
    setBytes(null);
    writeAnnotations(session.pdfLib, session.newBytes, session.index, results, session.options)
      .then((b) => { if (!stale) setBytes(b); })
      .catch((e) => { if (!stale) setError(errorMessage(e)); });
    return () => { stale = true; };
  }, [session, results]);

  const outName = newFile ? `${baseName(newFile.name)}-modified.pdf` : 'result.pdf';
  const pdfBlob = (): Blob => new Blob([new Uint8Array(bytes!)], { type: 'application/pdf' });

  async function share() {
    if (!bytes) return;
    const file = new File([pdfBlob()], outName, { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: file.name });
        return;
      } catch (e) {
        if ((e as { name?: string })?.name === 'AbortError') return;
      }
    }
    download(file, file.name);
  }

  function downloadReport() {
    if (!session) return;
    const md = buildReport(results, { oldName: session.oldName, newName: session.newName });
    download(new Blob([md], { type: 'text/markdown' }), `${baseName(session.newName)}-report.md`);
  }

  const summary = summarize(results);
  const approved = results.filter((r) => r.decision === 'approved').length;
  const rejected = results.filter((r) => r.decision === 'rejected').length;
  const undecided = results.filter((r) => !r.decision && !!r.match && (r.status === 'fuzzy' || r.status === 'ambiguous')).length;
  const toTransfer = results.filter((r) => !!r.match && r.decision !== 'rejected').length;

  const reviewCount = results.filter((r) => r.status !== 'exact').length;
  const stepIndex = STEPS.findIndex((x) => x.id === phase);
  const backToReview = reviewCount > 0;

  return (
    <div ref={topRef} className="flow">
      <header className="top">
        <h1>Carry Over Annotations</h1>
        {phase === 'upload' ? (
          <p className="sub">
            Transfer annotations and notes to a new version of the same PDF. Everything happens locally on this
            device; nothing is uploaded.
          </p>
        ) : (
          <ol className="steps" aria-label="Progress">
            {STEPS.map((st, i) => (
              <li key={st.id} className={i === stepIndex ? 'current' : i < stepIndex ? 'past' : ''} aria-current={i === stepIndex ? 'step' : undefined}>
                <span className="n">{i < stepIndex ? '✓' : i + 1}</span> {st.label}
              </li>
            ))}
          </ol>
        )}
      </header>

      {phase === 'upload' && (
        <section className="card narrow">
          <Picker step={1} title="Old PDF" placeholder="Choose the version with your annotations" file={oldFile} onPick={setOldFile} />
          <Picker step={2} title="New PDF" placeholder="Choose the new version" file={newFile} onPick={setNewFile} />

          <details>
            <summary>Options</summary>
            <label className="opt">
              <span>Mark unreviewed changes with ⚠ in the note</span>
              <input type="checkbox" checked={flagChanged} onChange={(e) => setFlagChanged(e.target.checked)} />
            </label>
            <label className="opt">
              <span>Sensitivity for changed text</span>
              <select value={minSimilarity} onChange={(e) => setMinSimilarity(parseFloat(e.target.value))}>
                <option value={0.8}>Strong (80%)</option>
                <option value={0.7}>Normal (70%)</option>
                <option value={0.6}>Loose (60%)</option>
              </select>
            </label>
          </details>

          <button className="big" onClick={run} disabled={!ready}>{busy ? 'Loading…' : 'Transfer Annotations'}</button>

          {progress && (
            <div>
              <div className="bar"><div className="barFill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>
              <p className="progText">{progress.text}</p>
            </div>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </section>
      )}

      {phase === 'review' && session && (
        <>
          <div className="chips">
            {summary.exact > 0 && <span className="chip"><b>{summary.exact}</b> exact transferred</span>}
            {summary.fuzzy > 0 && <span className="chip"><b>{summary.fuzzy}</b> changed text</span>}
            {summary.ambiguous > 0 && <span className="chip"><b>{summary.ambiguous}</b> ambiguous</span>}
            {summary.notfound > 0 && <span className="chip"><b>{summary.notfound}</b> not found</span>}
            {summary.unsupported > 0 && <span className="chip"><b>{summary.unsupported}</b> unsupported</span>}
          </div>
          <ReviewPanel
            oldDoc={session.oldDoc as unknown as RenderableDoc}
            newDoc={session.newDoc as unknown as RenderableDoc}
            index={session.index}
            results={results}
            onChange={setResults}
          />
          <div className="bottombar">
            <button className="secondary" onClick={startOver}>Cancel</button>
            <button className="big" onClick={() => goTo('save')}>
              {undecided > 0 ? `Continue (${undecided} not reviewed)` : 'Continue to Save'}
            </button>
          </div>
        </>
      )}

      {phase === 'save' && session && (
        <section className="card narrow">
          <h2>{toTransfer} of {results.length} annotations transferred</h2>
          <p className="hint">
            {summary.exact > 0 && <>{summary.exact} exact transferred</>}
            {approved > 0 && <> · {approved} approved</>}
            {rejected > 0 && <> · {rejected} rejected</>}
            {undecided > 0 && <> · {undecided} not reviewed (added{session.options.flagChanged ? ' with ⚠' : ''})</>}
            {summary.notfound + summary.unsupported > 0 && <> · {summary.notfound + summary.unsupported} not transferred</>}
          </p>
          <div className="actions">
            <button className="big" onClick={share} disabled={!bytes}>{bytes ? 'Save or Share PDF' : 'Preparing'}</button>
            <button className="secondary" onClick={() => bytes && download(pdfBlob(), outName)} disabled={!bytes}>Download PDF</button>
            <button className="secondary" onClick={downloadReport}>Report (.md)</button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions split">
            {backToReview && <button className="secondary" onClick={() => goTo('review')}>‹ Back to Review</button>}
            <button className="secondary" onClick={startOver}>Start New Document</button>
          </div>
        </section>
      )}
    </div>
  );
}
