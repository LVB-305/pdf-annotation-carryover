'use client';

import { useMemo, useState } from 'react';
import { applyMatch, kindLabel, STATUS_LABEL } from '@/lib/core';
import type { AnnotationRecord, DocIndex } from '@/lib/core';
import { wordDiff } from '@/lib/diff';
import type { DiffOp } from '@/lib/diff';
import PdfPageView from './PdfPageView';
import type { PageOverlay, RenderableDoc } from './PdfPageView';

interface Props {
  oldDoc: RenderableDoc;
  newDoc: RenderableDoc;
  index: DocIndex;
  results: AnnotationRecord[];
  onChange: (next: AnnotationRecord[]) => void;
}

const needsReview = (r: AnnotationRecord): boolean => r.status !== 'exact';
const actionable = (r: AnnotationRecord): boolean => !!r.match && (r.status === 'fuzzy' || r.status === 'ambiguous');

function stateSymbol(r: AnnotationRecord): string {
  if (r.decision === 'approved') return '✓';
  if (r.decision === 'rejected') return '✗';
  if (r.status === 'notfound' || r.status === 'unsupported') return '!';
  return '•';
}

function Diff({ ops }: { ops: DiffOp[] }) {
  return (
    <p className="diff">
      {ops.map((o, i) => (
        <span key={i} className={o.type === 'same' ? undefined : o.type}>{o.text}{' '}</span>
      ))}
    </p>
  );
}

/** GitHub-style review: uncertain matches show the old and new PDF side by side with approve or reject actions. */
export default function ReviewPanel({ oldDoc, newDoc, index, results, onChange }: Props) {
  const queue = useMemo(() => results.filter(needsReview), [results]);
  // Start with the first item that can be decided (not with "not found").
  const [current, setCurrent] = useState(() => Math.max(0, results.filter(needsReview).findIndex((r) => actionable(r) && !r.decision)));

  if (!queue.length) return null;
  const item = queue[Math.min(current, queue.length - 1)];
  const pos = queue.indexOf(item);

  const update = (id: string, patch: (r: AnnotationRecord) => AnnotationRecord) =>
    onChange(results.map((r) => (r.id === id ? patch({ ...r }) : r)));

  const nextPending = (from: number): number => {
    for (let k = 1; k <= queue.length; k++) {
      const j = (from + k) % queue.length;
      const q = queue[j];
      if (actionable(q) && !q.decision) return j;
    }
    return Math.min(from + 1, queue.length - 1);
  };

  const decide = (decision: 'approved' | 'rejected' | undefined) => {
    update(item.id, (r) => ({ ...r, decision }));
    if (decision) setCurrent(nextPending(pos));
  };

  const approveAll = () =>
    onChange(results.map((r) => (needsReview(r) && actionable(r) && !r.decision ? { ...r, decision: 'approved' } : r)));

  const cycleAlternative = (dir: 1 | -1) =>
    update(item.id, (r) => {
      const n = r.alternatives.length;
      const next = (r.altIndex + dir + n) % n;
      const [s, e] = r.alternatives[next];
      r.altIndex = next;
      applyMatch(index, r, s, e);
      return r;
    });

  const newText = item.match ? index.text.slice(item.match[0], item.match[1]) : '';
  const diff = item.match && item.status !== 'exact' ? wordDiff(item.text, newText) : null;

  const oldOverlays: PageOverlay[] = item.oldRects.map((r) => ({ page: item.page, ...r }));
  const newOverlays: PageOverlay[] = item.newRects;
  const newStart = item.newRects[0]?.page ?? item.newPage ?? item.expectedPage ?? 1;
  const pending = results.filter((r) => needsReview(r) && actionable(r) && !r.decision).length;

  return (
    <section className="card review" aria-label="Review annotations">
      <div className="review-head">
        <h2>Review ({pos + 1} / {queue.length})</h2>
        {pending > 1 && <button type="button" className="secondary small" onClick={approveAll}>Approve All ({pending})</button>}
      </div>

      <div className="pills" role="tablist" aria-label="Annotations to review">
        {queue.map((q, i) => (
          <button
            key={q.id}
            type="button"
            role="tab"
            aria-selected={i === pos}
            aria-label={`${kindLabel(q.kind)} on page ${q.page}: ${STATUS_LABEL[q.status]}${q.decision ? `, ${q.decision === 'approved' ? 'approved' : 'rejected'}` : ''}`}
            className={`pill ${q.status}${q.decision ? ` ${q.decision}` : ''}${i === pos ? ' current' : ''}`}
            onClick={() => setCurrent(i)}
          >
            {stateSymbol(q)} {i + 1}
          </button>
        ))}
      </div>

      <div className="item-head">
        <span className={`badge ${item.status}`}>{STATUS_LABEL[item.status]}</span>
        <span className="meta">
          {kindLabel(item.kind)}, old page {item.page}
          {item.newPage ? ` → new page ${item.newPage}` : ''}
        </span>
        {item.decision && <span className={`decision ${item.decision}`}>{item.decision === 'approved' ? 'Approved' : 'Rejected'}</span>}
      </div>

      {item.contents && <p className="meta">Note: {item.contents}</p>}
      {item.reason && <p className="meta">{item.reason}</p>}

      {diff && (
        <div className="diffbox">
          <div><span className="diff-label">Old</span><Diff ops={diff.old} /></div>
          <div><span className="diff-label">New</span><Diff ops={diff.new} /></div>
        </div>
      )}
      {!diff && item.text && <p className="quote">“{item.text}”</p>}

      <div className="viewers">
        <PdfPageView
          key={`old-${item.id}`}
          doc={oldDoc}
          initialPage={item.page}
          overlays={oldOverlays}
          color={item.color}
          label="Old PDF"
          tone="old"
          emptyNote="No position available."
        />
        <PdfPageView
          key={`new-${item.id}-${item.altIndex}-${item.match?.[0] ?? 'x'}`}
          doc={newDoc}
          initialPage={newStart}
          overlays={newOverlays}
          color={item.color}
          label="New PDF"
          tone="new"
          emptyNote="Not found in the new PDF. Nothing can be suggested."
        />
      </div>

      {item.alternatives.length > 1 && item.match && (
        <div className="alt">
          <span className="meta">Choose another location ({item.altIndex + 1} of {item.alternatives.length}):</span>
          <span className="alt-btns">
            <button type="button" className="secondary small" onClick={() => cycleAlternative(-1)}>‹ Previous</button>
            <button type="button" className="secondary small" onClick={() => cycleAlternative(1)}>Next ›</button>
          </span>
        </div>
      )}

      {item.log.length > 0 && (
        <details className="diag">
          <summary>Diagnostics (why here?)</summary>
          <pre>{item.log.join('\n')}</pre>
        </details>
      )}

      <div className="decide">
        {actionable(item) ? (
          <>
            <button type="button" className={`reject${item.decision === 'rejected' ? ' on' : ''}`} onClick={() => decide('rejected')}>Reject</button>
            <button type="button" className={`approve${item.decision === 'approved' ? ' on' : ''}`} onClick={() => decide('approved')}>Approve</button>
          </>
        ) : (
          <button type="button" className="secondary" onClick={() => setCurrent(Math.min(pos + 1, queue.length - 1))} disabled={pos >= queue.length - 1}>
            Next
          </button>
        )}
      </div>
      {item.decision && (
        <button type="button" className="link" onClick={() => decide(undefined)}>Undo decision</button>
      )}
    </section>
  );
}