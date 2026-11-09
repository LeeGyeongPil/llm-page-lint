// 브라우저 측 탐지기 — page.evaluate(detectInPage, opts) 로 페이지 안에서 실행된다.
//
// 규칙: 이 파일의 함수는 문자열로 직렬화되어 브라우저로 넘어간다.
//   - 바깥(모듈) 변수·import·다른 함수를 참조하지 않는다. 필요한 헬퍼는 함수 안에 둔다.
//   - 반환값은 "믿을 수 없는 값"으로 취급된다. 부모(Node)가 validate.ts 에서 다시 검사한다.
//
// 핵심 아이디어: 스크린샷을 모델에게 보여주는 대신, 브라우저가 계산한 좌표로 결함을 수식으로 판정한다.
//   - 글자 하나하나에 Range 를 씌워 getClientRects() 로 좌표를 얻고, top 이 같은 글자끼리 묶으면 "렌더링된 줄"이 된다.
//   - 줄 상자끼리 겹치면 overlap_text, 줄이 잘라내는 상자 밖으로 나가면 clipped_text …

export interface DetectOptions {
  /** 'full' = 탐지 전부, 'snapshot' = 바뀌는 글자 비교용 텍스트만 */
  mode: 'full' | 'snapshot';
  /** 검사에서 뺄 선택자 */
  ignore: string[];
  /** 블록당 측정할 글자 수 상한 */
  maxCharsPerBlock: number;
  /** 페이지 전체 측정 글자 수 상한 */
  maxCharsTotal: number;
}

export interface RawRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RawFinding {
  kind: string;
  selector: string;
  section: string | null;
  rect: RawRect;
  detail: Record<string, string | number | boolean>;
}

export interface ContrastCandidate {
  selector: string;
  section: string | null;
  color: string;
  fontSize: number;
  fontWeight: number;
  /** 글자 줄 상자(페이지 좌표) — 이 영역의 배경 픽셀만 잰다 */
  lines: RawRect[];
}

export interface TextSnapshotItem {
  selector: string;
  section: string | null;
  text: string;
  rect: RawRect;
}

export interface RawDetectResult {
  findings: RawFinding[];
  contrastCandidates: ContrastCandidate[];
  snapshot: TextSnapshotItem[];
  truncated: boolean;
  pageWidth: number;
  pageHeight: number;
  viewportWidth: number;
}

export function detectInPage(opts: DetectOptions): RawDetectResult {
  // ---------- 원본 측정 함수 ----------
  // 초기화 스크립트(init.ts)가 고정해 둔 원본을 쓴다. 없으면(사용자가 직접 넘긴 page) 평소 함수를 쓴다.
  const G = (window as any).__llmPageLint;
  const rectOf = (el: Element): DOMRect => (G ? G.rect(el) : el.getBoundingClientRect());
  const styleOf = (el: Element, pseudo?: string): CSSStyleDeclaration =>
    G ? G.style(window, el, pseudo) : getComputedStyle(el, pseudo);
  const charRect = (node: Text, i: number): DOMRect | null => {
    const r: Range = G ? G.createRange(document) : document.createRange();
    if (G) {
      G.setStart(r, node, i);
      G.setEnd(r, node, i + 1);
    } else {
      r.setStart(node, i);
      r.setEnd(node, i + 1);
    }
    const list: DOMRectList = G ? G.rangeRects(r) : r.getClientRects();
    return list.length ? list[0] : null;
  };
  const walker = (root: Node, what: number): TreeWalker =>
    G ? G.createTreeWalker(document, root, what) : document.createTreeWalker(root, what);
  // push 대신 길이 위치에 넣는다(Array.prototype.push 가 바뀌었어도 영향 없음).
  const add = <T>(arr: T[], item: T) => {
    arr[arr.length] = item;
  };

  const sx = window.scrollX;
  const sy = window.scrollY;
  const vw = document.documentElement.clientWidth;
  const body = document.body;
  const out: RawFinding[] = [];
  let truncated = false;

  const ignoreList = opts.ignore || [];
  const isIgnored = (el: Element): boolean => {
    if (el.closest('[aria-hidden="true"]')) return true; // 장식 요소는 검사하지 않는다
    for (const s of ignoreList) if (el.closest(s)) return true;
    return false;
  };

  // ---------- 선택자·섹션 이름 ----------
  const simpleIdent = /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/;
  const sel = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      const id = cur.id;
      if (id && simpleIdent.test(id) && document.querySelectorAll('#' + id).length === 1) {
        parts.unshift('#' + id);
        break;
      }
      let part = cur.tagName.toLowerCase();
      const cls = cur.classList.length ? cur.classList[0] : '';
      if (cls && simpleIdent.test(cls)) part += '.' + cls;
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    let s = parts.join(' > ');
    // 200자를 넘으면 뒤쪽(요소에 가까운 쪽)만 남긴다 — 부모 재검증의 길이 상한과 맞춘다.
    while (s.length > 200 && parts.length > 1) {
      parts.shift();
      s = parts.join(' > ');
    }
    return s.slice(0, 200);
  };
  const sectionOf = (el: Element): string | null => {
    const tagged = el.closest('[data-section]');
    if (tagged) return (tagged.getAttribute('data-section') || '').slice(0, 80) || null;
    const box = el.closest('section,header,footer');
    if (box) return (box.id || box.tagName.toLowerCase()).slice(0, 80);
    return null;
  };
  const toPage = (r: DOMRect): RawRect => ({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height });

  // ---------- 보이는지·화면 낭독기 전용인지 ----------
  const isHiddenByStyle = (el: Element): boolean => {
    const cs = styleOf(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
      if (parseFloat(styleOf(a).opacity) === 0) return true;
    }
    return false;
  };
  const isScreenReaderOnly = (el: Element): boolean => {
    for (let a: Element | null = el; a && a !== body; a = a.parentElement) {
      const cs = styleOf(a);
      if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.clipPath === 'inset(50%)') return true;
      const r = rectOf(a);
      if (r.width <= 1 && r.height <= 1 && /(hidden|clip)/.test(cs.overflow)) return true;
    }
    return false;
  };

  // ---------- 1단계: 글자를 가진 블록과 렌더링된 줄 ----------
  // 블록 = 글자 노드를 직접 가진 요소에서 inline 조상을 건너뛴 첫 블록 요소.
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
  const blockTexts = new Map<Element, Text[]>();
  const tw = walker(body, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    const t = tw.currentNode as Text;
    const parent = t.parentElement;
    if (!parent || SKIP.has(parent.tagName) || !t.data.trim()) continue;
    let b: Element = parent;
    while (b !== body && b.parentElement && styleOf(b).display.startsWith('inline')) b = b.parentElement;
    const list = blockTexts.get(b);
    if (list) add(list, t);
    else blockTexts.set(b, [t]);
  }

  interface Line {
    x: number;
    y: number;
    r: number;
    b: number;
    text: string;
  }
  interface Block {
    el: Element;
    selector: string;
    section: string | null;
    lines: Line[];
    texts: Text[];
  }
  const blocks: Block[] = [];
  let totalChars = 0;

  for (const [el, texts] of blockTexts) {
    if (isIgnored(el) || isHiddenByStyle(el) || isScreenReaderOnly(el)) continue;
    const lines: Line[] = [];
    let measured = 0;
    for (const t of texts) {
      for (let i = 0; i < t.length; i++) {
        const ch = t.data[i];
        if (/\s/.test(ch)) continue;
        if (measured >= opts.maxCharsPerBlock || totalChars >= opts.maxCharsTotal) {
          truncated = true;
          break;
        }
        measured++;
        totalChars++;
        const rc = charRect(t, i);
        if (!rc || rc.width === 0 || rc.height === 0) continue;
        const x = rc.left + sx;
        const y = rc.top + sy;
        const last = lines.length ? lines[lines.length - 1] : null;
        // 같은 줄: top 차이가 작고(인라인 블록 기준선 차이 허용) 왼쪽으로 되돌아가지 않았다
        if (last && Math.abs(y - last.y) <= Math.max(3, rc.height * 0.3) && x >= last.x - 1) {
          last.r = Math.max(last.r, x + rc.width);
          last.b = Math.max(last.b, y + rc.height);
          last.y = Math.min(last.y, y);
          last.text += ch;
        } else {
          add(lines, { x, y, r: x + rc.width, b: y + rc.height, text: ch });
        }
      }
    }
    // line-clamp hides the extra lines on purpose: they take no part in any check, so cut them here.
    const bcs0 = styleOf(el);
    if ((bcs0 as any).webkitLineClamp && (bcs0 as any).webkitLineClamp !== 'none') {
      const bottom = rectOf(el).bottom + sy;
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i].y >= bottom - 1) lines.length = i;
    }
    if (!lines.length) continue;
    add(blocks, { el, selector: sel(el), section: sectionOf(el), lines, texts });
  }

  const lineRect = (l: Line): RawRect => ({ x: l.x, y: l.y, w: l.r - l.x, h: l.b - l.y });
  const textOf = (b: Block) =>
    b.texts
      .map((t) => t.data)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

  // 'snapshot' 모드: 바뀌는 글자 비교용으로 블록별 텍스트만 돌려준다.
  const snapshot: TextSnapshotItem[] = [];
  for (const b of blocks) {
    const first = b.lines[0];
    add(snapshot, { selector: b.selector, section: b.section, text: textOf(b).slice(0, 200), rect: lineRect(first) });
  }
  const pageWidth = document.documentElement.scrollWidth;
  const pageHeight = document.documentElement.scrollHeight;
  if (opts.mode === 'snapshot') {
    return { findings: [], contrastCandidates: [], snapshot, truncated, pageWidth, pageHeight, viewportWidth: vw };
  }

  // ---------- orphan_punct: 2번째 이후 줄이 닫는 문장부호로 시작 ----------
  // (따옴표 ' " 는 여는 따옴표일 수 있어 뺀다)
  const CLOSING = /^[.,;:!?)\]}»”’…、。，．！？：；）」』】〉》]/;
  for (const b of blocks) {
    for (let i = 1; i < b.lines.length; i++) {
      if (CLOSING.test(b.lines[i].text)) {
        add(out, {
          kind: 'orphan_punct',
          selector: b.selector,
          section: b.section,
          rect: lineRect(b.lines[i]),
          detail: { text: b.lines[i].text.slice(0, 60), line: i + 1 },
        });
        break; // 블록당 1건
      }
    }
  }

  // ---------- overlap_text: 서로 다른 블록의 줄 상자가 20px² 넘게 교차 ----------
  const bbox = (b: Block) => {
    let x = Infinity, y = Infinity, r = -Infinity, bt = -Infinity;
    for (const l of b.lines) {
      x = Math.min(x, l.x);
      y = Math.min(y, l.y);
      r = Math.max(r, l.r);
      bt = Math.max(bt, l.b);
    }
    return { x, y, r, b: bt };
  };
  const boxes = blocks.map(bbox);
  // Lines hidden by an overflow:hidden/clip ancestor are not drawn, so they cannot overlap anything
  // (the clipping itself is reported by clipped_text).
  const visibleCache = new Map<Block, Line[]>();
  const visibleLines = (b: Block): Line[] => {
    const cached = visibleCache.get(b);
    if (cached) return cached;
    const clips: { l: number; t: number; r: number; b: number; cx: boolean; cy: boolean }[] = [];
    for (let a: Element | null = b.el; a && a !== document.documentElement; a = a.parentElement) {
      const cs = styleOf(a);
      const cx = /(hidden|clip)/.test(cs.overflowX);
      const cy = /(hidden|clip)/.test(cs.overflowY);
      if (!cx && !cy) continue;
      const rc = rectOf(a);
      const l = rc.left + sx + a.clientLeft, t = rc.top + sy + a.clientTop;
      clips.push({ l, t, r: l + a.clientWidth, b: t + a.clientHeight, cx, cy });
    }
    const result: Line[] = [];
    for (const ln of b.lines) {
      let x = ln.x, y = ln.y, r = ln.r, bt = ln.b;
      for (const c of clips) {
        if (c.cx) { x = Math.max(x, c.l); r = Math.min(r, c.r); }
        if (c.cy) { y = Math.max(y, c.t); bt = Math.min(bt, c.b); }
      }
      if (r > x && bt > y) result.push({ x, y, r, b: bt, text: ln.text });
    }
    visibleCache.set(b, result);
    return result;
  };
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const A = boxes[i], B = boxes[j];
      if (A.r <= B.x || B.r <= A.x || A.b <= B.y || B.b <= A.y) continue;
      if (blocks[i].el.contains(blocks[j].el) || blocks[j].el.contains(blocks[i].el)) continue;
      let best = 0;
      let bestRect: RawRect | null = null;
      for (const p of visibleLines(blocks[i])) {
        for (const q of visibleLines(blocks[j])) {
          const ix = Math.max(p.x, q.x), iy = Math.max(p.y, q.y);
          const iw = Math.min(p.r, q.r) - ix, ih = Math.min(p.b, q.b) - iy;
          if (iw > 0 && ih > 0 && iw * ih > best) {
            best = iw * ih;
            bestRect = { x: ix, y: iy, w: iw, h: ih };
          }
        }
      }
      if (best > 20 && bestRect) {
        // 위쪽 블록을 주인으로, 아래쪽 블록을 other 로 둔다(수정자가 "아래를 밀어내기" 처방을 고를 때 쓴다)
        const upperFirst = A.y <= B.y;
        const upper = upperFirst ? blocks[i] : blocks[j];
        const lower = upperFirst ? blocks[j] : blocks[i];
        add(out, {
          kind: 'overlap_text',
          selector: upper.selector,
          section: upper.section,
          rect: bestRect,
          detail: { other: lower.selector, areaPx: Math.round(best), overlapHeight: Math.round(bestRect.h) },
        });
      }
    }
  }

  // ---------- clipped_text: overflow hidden/clip 상자 밖으로 글자 줄이 나감 ----------
  // 안쪽 상자부터 보고(문서 순서의 역순), 이미 보고한 줄은 바깥 상자에서 다시 세지 않는다.
  const claimed = new Set<Line>();
  const all = Array.from(body.querySelectorAll('*'));
  for (let k = all.length - 1; k >= 0; k--) {
    const el = all[k];
    const cs = styleOf(el);
    const clipX = /(hidden|clip)/.test(cs.overflowX);
    const clipY = /(hidden|clip)/.test(cs.overflowY);
    if (!clipX && !clipY) continue;
    if (cs.textOverflow === 'ellipsis' || ((cs as any).webkitLineClamp && (cs as any).webkitLineClamp !== 'none')) continue; // 의도적 말줄임
    if (isIgnored(el) || isHiddenByStyle(el) || isScreenReaderOnly(el)) continue;
    const r = rectOf(el);
    const left = r.left + sx + el.clientLeft, top = r.top + sy + el.clientTop;
    const right = left + el.clientWidth, bottom = top + el.clientHeight;
    let hidden = 0;
    let axis = 'y';
    for (const b of blocks) {
      if (!el.contains(b.el)) continue;
      const bcs = styleOf(b.el);
      if (bcs.textOverflow === 'ellipsis' || ((bcs as any).webkitLineClamp && (bcs as any).webkitLineClamp !== 'none')) continue;
      for (const l of b.lines) {
        if (claimed.has(l)) continue;
        const hy = clipY ? Math.max(0, l.b - bottom, top - l.y) : 0;
        // 가로는 "걸쳐서 잘린" 줄만 센다(완전히 밖에 있는 줄은 캐러셀의 다음 장일 가능성이 크다)
        const straddleX = (l.x < left && l.r > left) || (l.x < right && l.r > right);
        const hx = clipX && straddleX ? Math.max(0, l.r - right, left - l.x) : 0;
        if (hy > 2 || hx > 2) {
          claimed.add(l);
          if (hy >= hx) {
            if (hy > hidden) {
              hidden = hy;
              axis = 'y';
            }
          } else if (hx > hidden) {
            hidden = hx;
            axis = 'x';
          }
        }
      }
    }
    if (hidden > 2) {
      add(out, {
        kind: 'clipped_text',
        selector: sel(el),
        section: sectionOf(el),
        rect: toPage(r),
        detail: { hiddenPx: Math.round(hidden), axis },
      });
    }
  }

  // ---------- offscreen_text: 글자가 뷰포트 왼쪽·오른쪽·위쪽 밖 ----------
  const insideScroller = (el: Element): boolean => {
    for (let a = el.parentElement; a && a !== body && a !== document.documentElement; a = a.parentElement) {
      if (!/visible/.test(styleOf(a).overflowX)) return true; // 가로 스크롤·잘라내는 상자 안이면 화면 밖이 아니라 그 상자 문제
    }
    return false;
  };
  for (const b of blocks) {
    if (insideScroller(b.el)) continue;
    const box = bbox(b);
    let side = '';
    let px = 0;
    if (box.r - sx > vw + 1) {
      side = 'right';
      px = box.r - sx - vw;
    } else if (box.x - sx < -1) {
      side = 'left';
      px = sx - box.x;
    } else if (box.b < -1) {
      side = 'top';
      px = -box.y;
    }
    if (side) {
      add(out, {
        kind: 'offscreen_text',
        selector: b.selector,
        section: b.section,
        rect: toPage(rectOf(b.el)),
        detail: { side, overflowPx: Math.round(px) },
      });
    }
  }

  // ---------- empty_box: 배경·테두리가 있는 5000px² 이상 상자에 글자·미디어가 없음 ----------
  const MEDIA = 'img,svg,video,canvas,iframe,picture,object,embed,input,button,select,textarea';
  const reportedEmpty: Element[] = [];
  const alpha = (c: string) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return c === 'transparent' ? 0 : 1;
    const p = m[1].split(/[,\s/]+/).filter(Boolean);
    return p.length >= 4 ? parseFloat(p[3]) : 1;
  };
  for (const el of Array.from(body.querySelectorAll('div,section,article,aside,li,figure,main,header,footer,span,p'))) {
    if (reportedEmpty.some((a) => a.contains(el))) continue;
    if (isIgnored(el) || isHiddenByStyle(el)) continue;
    const cs = styleOf(el);
    if (cs.display.startsWith('inline') && cs.display !== 'inline-block') continue;
    const r = rectOf(el);
    if (r.width * r.height <= 5000 || r.width < 24 || r.height < 24) continue;
    const bg = cs.backgroundImage;
    if (bg.includes('url(')) continue; // 배경 사진은 내용이다
    const border = ['Top', 'Right', 'Bottom', 'Left'].some(
      (s) => parseFloat((cs as any)['border' + s + 'Width']) > 0 && (cs as any)['border' + s + 'Style'] !== 'none',
    );
    const decorated = alpha(cs.backgroundColor) > 0 || bg.includes('gradient') || border;
    if (!decorated) continue;
    if ((el as HTMLElement).innerText.trim()) continue;
    if (el.querySelector(MEDIA)) continue;
    const before = styleOf(el, '::before').content, after = styleOf(el, '::after').content;
    if ((before && before !== 'none' && before !== 'normal') || (after && after !== 'none' && after !== 'normal')) continue;
    add(reportedEmpty, el);
    add(out, {
      kind: 'empty_box',
      selector: sel(el),
      section: sectionOf(el),
      rect: toPage(r),
      detail: { areaPx: Math.round(r.width * r.height) },
    });
  }

  // ---------- cut_image: overflow 조상(섹션 경계 등)에 이미지가 걸쳐 잘림 ----------
  const images = Array.from(body.querySelectorAll('img,video,canvas,svg')).filter(
    (e) => !(e.tagName.toLowerCase() === 'svg' && e.parentElement && e.parentElement.closest('svg')),
  );
  for (const img of images) {
    if (isIgnored(img) || isHiddenByStyle(img)) continue;
    const r = rectOf(img);
    const area = r.width * r.height;
    if (area < 100) continue;
    let vx0 = r.left, vy0 = r.top, vx1 = r.right, vy1 = r.bottom;
    let clipper: Element | null = null;
    for (let a = img.parentElement; a && a !== body && a !== document.documentElement; a = a.parentElement) {
      const cs = styleOf(a);
      const cx = /(hidden|clip)/.test(cs.overflowX), cy = /(hidden|clip)/.test(cs.overflowY);
      if (!cx && !cy) continue;
      const ar = rectOf(a);
      const l = ar.left + a.clientLeft, t = ar.top + a.clientTop;
      const nx0 = cx ? Math.max(vx0, l) : vx0, nx1 = cx ? Math.min(vx1, l + a.clientWidth) : vx1;
      const ny0 = cy ? Math.max(vy0, t) : vy0, ny1 = cy ? Math.min(vy1, t + a.clientHeight) : vy1;
      if (!clipper && (nx0 > vx0 + 0.5 || nx1 < vx1 - 0.5 || ny0 > vy0 + 0.5 || ny1 < vy1 - 0.5)) clipper = a;
      vx0 = nx0;
      vx1 = nx1;
      vy0 = ny0;
      vy1 = ny1;
    }
    if (!clipper) continue;
    const visible = Math.max(0, vx1 - vx0) * Math.max(0, vy1 - vy0);
    const ratio = visible / area;
    const cut = r.height - Math.max(0, vy1 - vy0) + (r.width - Math.max(0, vx1 - vx0));
    // 완전히 가려진 것(캐러셀의 다른 장)은 "잘린 이미지"가 아니다
    if (ratio <= 0.02 || ratio >= 0.98 || cut <= 2) continue;
    add(out, {
      kind: 'cut_image',
      selector: sel(img),
      section: sectionOf(img),
      rect: toPage(r),
      detail: { clipper: sel(clipper), cutPx: Math.round(cut), visibleRatio: Math.round(ratio * 100) / 100 },
    });
  }

  // ---------- 이미지·그라디언트 위 글자 후보(대비는 부모가 픽셀로 잰다) ----------
  const candidates: ContrastCandidate[] = [];
  for (const b of blocks) {
    let overImage = false;
    for (let a: Element | null = b.el; a; a = a.parentElement) {
      const cs = styleOf(a);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') {
        overImage = true;
        break;
      }
      if (alpha(cs.backgroundColor) >= 1) break; // 불투명 단색 배경이 먼저 덮으면 이미지 위가 아니다
    }
    if (!overImage) continue;
    const cs = styleOf(b.el);
    add(candidates, {
      selector: b.selector,
      section: b.section,
      color: cs.color,
      fontSize: parseFloat(cs.fontSize),
      fontWeight: parseFloat(cs.fontWeight) || 400,
      lines: b.lines.slice(0, 20).map(lineRect),
    });
  }

  return { findings: out, contrastCandidates: candidates, snapshot, truncated, pageWidth, pageHeight, viewportWidth: vw };
}
