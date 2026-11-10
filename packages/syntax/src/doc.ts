// Whole-document conversion between PukiWiki source and an editor document.
// Unchanged blocks are written back byte-for-byte; changed or new blocks are
// written in canonical form while keeping the original trailing blank lines.
import { canonical, parseBlocks } from './blocks.ts';
import type { PMNode } from './blocks.ts';

export interface BlockMeta { core: string; trailing: string }
export interface EditorDoc { doc: PMNode; meta: Record<string, BlockMeta> }

let seq = 0;
const newBid = () => `b${Date.now().toString(36)}${(seq++).toString(36)}`;

export function toEditorDoc(source: string): EditorDoc {
  const meta: Record<string, BlockMeta> = {};
  const content = parseBlocks(source).map((b) => {
    const bid = newBid();
    meta[bid] = { core: b.core, trailing: b.trailing };
    return { ...b.node, attrs: { ...(b.node.attrs ?? {}), bid } };
  });
  return { doc: { type: 'doc', content }, meta };
}

// Blocks after which a following paragraph would be merged into them by PukiWiki
const ABSORBING = new Set(['paragraph', 'pkList', 'pkRaw']);

export function fromEditorDoc(doc: PMNode, meta: Record<string, BlockMeta>): string {
  let out = '';
  let prev: { type: string; trailing: string; changed: boolean } | null = null;
  const used = new Set<string>();
  for (const node of (doc.content ?? []) as PMNode[]) {
    const bid: string | undefined = node.attrs?.bid;
    const m = bid && !used.has(bid) ? meta[bid] : undefined;
    if (bid) used.add(bid);
    let core = canonical(node);
    const changed = !m || core !== m.core;
    // a new block placed at the very end of a file that had no final newline
    if (changed && out && !out.endsWith('\n')) out += '\n';
    if (changed && !core.endsWith('\n') && core !== '') core += '\n';
    if (prev && (changed || prev.changed) && prev.trailing === '' &&
        ABSORBING.has(prev.type) && (node.type === 'paragraph' || node.type === 'pkRaw')) {
      out += '\n';
    }
    const trailing = m ? m.trailing : '';
    out += core + trailing;
    prev = { type: node.type, trailing, changed };
  }
  return out;
}

/** Share of blocks that can be edited visually (not raw). */
export function visualCoverage(source: string): { blocks: number; raw: number; reasons: string[] } {
  const blocks = parseBlocks(source).filter((b) => b.core !== '');
  const raw = blocks.filter((b) => b.node.type === 'pkRaw');
  return { blocks: blocks.length, raw: raw.length, reasons: raw.map((b) => b.node.attrs?.reason ?? '') };
}
