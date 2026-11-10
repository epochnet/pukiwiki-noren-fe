import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router';
import { api, local, pagePath, wapi } from '../api.ts';
import { useApp } from '../context.tsx';
import { Icon } from './Icon.tsx';
import { MenuCalendar } from './MenuCalendar.tsx';

interface Node { name: string; label: string; title: string; children: number; virtual: number; is_date: number; group?: boolean; items?: Node[] }

const spaceOf = (p: string) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : p);

/** Group long runs of date pages into year → month folders. */
function groupDates(rows: Node[], parent: string): Node[] {
  const dates = rows.filter((r) => r.is_date);
  if (dates.length <= 30) return rows;
  const others = rows.filter((r) => !r.is_date);
  const years = new Map<string, Map<string, Node[]>>();
  for (const d of dates) {
    const y = d.label.slice(0, 4), m = d.label.slice(5, 7);
    if (!years.has(y)) years.set(y, new Map());
    const mm = years.get(y)!;
    if (!mm.has(m)) mm.set(m, []);
    mm.get(m)!.push(d);
  }
  const groups: Node[] = [...years.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([y, months]) => ({
    name: `${parent}/#${y}`, label: `${y} 年`, title: y, children: 0, virtual: 1, is_date: 0, group: true,
    items: [...months.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([m, items]) => ({
      name: `${parent}/#${y}-${m}`, label: `${Number(m)} 月`, title: m, children: items.length, virtual: 1, is_date: 0, group: true, items,
    })),
  }));
  return [...groups, ...others];
}

function TreeItem({ node, depth, active, expanded, toggle }: { node: Node; depth: number; active: string | null; expanded: Set<string>; toggle: (n: string) => void }) {
  const app = useApp();
  const open = expanded.has(node.name);
  const [kids, setKids] = useState<Node[] | null>(node.items ?? null);
  const hasKids = node.group || node.children > 0;
  useEffect(() => {
    if (!open || node.group || !hasKids) return;
    let alive = true;
    api<Node[]>(`${wapi(app.wiki)}/tree?parent=${encodeURIComponent(node.name)}`)
      .then((r) => { if (alive) setKids(groupDates(r, node.name)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [open, node.name, node.group, hasKids, app.wiki, app.treeVersion]);
  const isActive = active === node.name;
  const count = node.group ? undefined : node.children || undefined;
  return (
    <li>
      <div className={`tree-row ${isActive ? 'active' : ''}`}>
        {hasKids ? (
          <button className="tree-chev" aria-label={open ? `${node.label} を閉じる` : `${node.label} を開く`} aria-expanded={open} onClick={() => toggle(node.name)}>
            <Icon name={open ? 'down' : 'right'} />
          </button>
        ) : <span className="tree-chev" aria-hidden="true"><Icon name="file" /></span>}
        {node.group || node.virtual
          ? <button className="tree-label as-text" onClick={() => toggle(node.name)}>{node.label}</button>
          : <Link className="tree-label" to={pagePath(app.wiki, node.name)} aria-current={isActive ? 'page' : undefined}>{node.label}</Link>}
        {count ? <span className="count">{count}</span> : null}
      </div>
      {open && hasKids && (
        <ul>
          {kids === null ? <li className="tree-loading">読み込み中…</li>
            : kids.map((k) => <TreeItem key={k.name} node={k} depth={depth + 1} active={active} expanded={expanded} toggle={toggle} />)}
        </ul>
      )}
    </li>
  );
}

const MENUBAR = 'MenuBar';

/** Swap the #calendar2 output (rendered for the MenuBar page itself) for a slot that MenuCalendar fills. */
function withCalendarSlots(html: string): string {
  if (!html.includes('style_calendar')) return html;
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  doc.querySelectorAll('table.style_calendar').forEach((t) => {
    const box = t.closest('.table-wrap') ?? t;
    const slot = doc.createElement('div');
    slot.className = 'mb-cal-slot';
    box.replaceWith(slot);
  });
  return doc.getElementById('r')!.innerHTML;
}

/** The wiki's MenuBar page (if it exists), collapsible, at the top of the sidebar. */
function MenuBarBox() {
  const app = useApp();
  const nav = useNavigate();
  const [html, setHtml] = useState<string | null>(null);
  const openKey = `noren:menubar-open:${app.wiki}`;
  const [open, setOpen] = useState(() => local.get<boolean>(openKey, true));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api<{ exists: boolean; html: string }>(`${wapi(app.wiki)}/page?p=${encodeURIComponent(MENUBAR)}`)
      .then((r) => { if (alive) setHtml(r.exists && r.html.trim() ? withCalendarSlots(r.html) : null); })
      .catch(() => { if (alive) setHtml(null); });
    return () => { alive = false; };
  }, [app.wiki, app.treeVersion]);

  // in-app navigation for internal links
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('/w/')) { e.preventDefault(); nav(href); }
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [html, open, nav]);

  // calendar slots inside the MenuBar HTML
  const [slots, setSlots] = useState<Element[]>([]);
  useLayoutEffect(() => {
    setSlots(ref.current ? [...ref.current.querySelectorAll('.mb-cal-slot')] : []);
  }, [html]);

  if (!html) return null;
  return (
    <details className="menubar-box" open={open} onToggle={(e) => {
      const v = (e.currentTarget as HTMLDetailsElement).open;
      setOpen(v);
      local.set(openKey, v);
    }}>
      <summary>
        <Icon name={open ? 'down' : 'right'} />メニュー
        <Link className="menubar-edit" to={pagePath(app.wiki, MENUBAR, 'mode=edit')} onClick={(e) => e.stopPropagation()} aria-label="メニュー（MenuBar）を編集">編集</Link>
      </summary>
      <div className="menubar-body" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
      {slots.map((el, i) => createPortal(<MenuCalendar />, el, `cal${i}`))}
    </details>
  );
}

export function Sidebar() {
  const app = useApp();
  const current = app.currentPage;
  const space = current ? spaceOf(current) : null;
  const [roots, setRoots] = useState<Node[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [spaceInfo, setSpaceInfo] = useState<{ pages: number } | null>(null);

  // tree root: the current space's children, or the list of spaces
  useEffect(() => {
    let alive = true;
    setRoots(null);
    const url = space ? `${wapi(app.wiki)}/tree?parent=${encodeURIComponent(space)}` : `${wapi(app.wiki)}/tree`;
    api<Node[]>(url).then((r) => { if (alive) setRoots(space ? groupDates(r, space) : r); }).catch(() => setRoots([]));
    if (space) api<any[]>(`${wapi(app.wiki)}/spaces`).then((s) => { if (alive) setSpaceInfo(s.find((x) => x.space === space) ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [app.wiki, space, app.treeVersion]);

  // expand ancestors of the current page (including date groups)
  useEffect(() => {
    if (!current) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = current.split('/');
      for (let i = 1; i < parts.length; i++) {
        const anc = parts.slice(0, i).join('/');
        next.add(anc);
        const seg = parts[i];
        if (/^\d{4}-\d\d-\d\d$/.test(seg)) {
          next.add(`${anc}/#${seg.slice(0, 4)}`);
          next.add(`${anc}/#${seg.slice(0, 7)}`);
        }
      }
      return next;
    });
  }, [current]);

  const toggle = (n: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(n)) next.delete(n); else next.add(n);
    return next;
  });
  const recent = useMemo(() => local.get<string[]>(`noren:recent:${app.wiki}`, []).filter((p) => p !== current).slice(0, 5), [app.wiki, current]);
  const favs = local.get<string[]>(`noren:fav:${app.wiki}`, []);
  const w = encodeURIComponent(app.wiki);

  return (
    <nav className="sidebar" aria-label="スペースとページツリー">
      <MenuBarBox />
      {space ? (
        <>
          <div className="space-head">
            <span className="space-icon" aria-hidden="true">{space.slice(0, 1)}</span>
            <div><Link to={pagePath(app.wiki, space)} className="space-name">{space}</Link><small>{spaceInfo ? `${spaceInfo.pages.toLocaleString()} ページ` : ''}</small></div>
          </div>
          <Link className="navlink" to={`/w/${w}`}><Icon name="home" />ダッシュボード</Link>
          <Link className="navlink" to={`/w/${w}/calendar/${space.split('/').map(encodeURIComponent).join('/')}`}><Icon name="cal" />カレンダー表示</Link>
          <div className="nav-label">ページ</div>
        </>
      ) : (
        <>
          <Link className="navlink" to={`/w/${w}`}><Icon name="home" />ダッシュボード</Link>
          <Link className="navlink" to={`/w/${w}/recent`}><Icon name="clock" />最近の更新</Link>
          <div className="nav-label">スペース</div>
        </>
      )}
      <ul className="tree">
        {roots === null ? <li className="tree-loading">読み込み中…</li>
          : roots.length === 0 ? <li className="tree-loading">ページがありません</li>
          : roots.map((n) => <TreeItem key={n.name} node={n} depth={0} active={current} expanded={expanded} toggle={toggle} />)}
      </ul>
      {recent.length > 0 && (
        <>
          <div className="nav-label">最近見たページ</div>
          {recent.map((p) => <Link key={p} className="navlink" to={pagePath(app.wiki, p)} title={p}><Icon name="clock" /><span className="ellipsis">{p}</span></Link>)}
        </>
      )}
      {favs.length > 0 && (
        <>
          <div className="nav-label">お気に入り</div>
          {favs.map((p) => <Link key={p} className="navlink" to={pagePath(app.wiki, p)} title={p}><Icon name="star" /><span className="ellipsis">{p}</span></Link>)}
        </>
      )}
      {space && (
        <>
          <div className="nav-label">他のスペース</div>
          <Link className="navlink" to={`/w/${w}/pages`}><Icon name="grid" />すべてのスペース・ページ</Link>
        </>
      )}
    </nav>
  );
}
