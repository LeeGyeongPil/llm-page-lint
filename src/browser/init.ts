// 초기화 스크립트(addInitScript) — 검사 대상 페이지의 스크립트보다 "먼저" 실행된다.
//
// 왜 필요한가: page.evaluate 로 돌리는 탐지기는 페이지와 같은 JS 전역을 공유한다.
// 페이지가 Element.prototype.getBoundingClientRect 나 Array.prototype.push 를 바꿔 두면
// 결함을 숨기거나(좌표를 0 으로) 가짜 결함을 끼워 넣을(push 가로채기) 수 있다.
// 그래서 페이지 스크립트가 돌기 전에 원본 함수를 잡아 두고, 그 속성을 바꿀 수 없게 고정한다.
//
// 이 함수는 문자열로 직렬화되어 브라우저 안에서 돈다 — 바깥 변수·import 를 참조하면 안 된다.
// 완전한 격리는 아니다: 여기서 고정하지 않은 것(scrollHeight 같은 크기 getter 등)은
// 페이지가 요소별로 덮어쓸 수 있고, 그 값은 부모(Node) 측 재검증(validate.ts)이 범위로 거른다.

export const GUARD_KEY = '__llmPageLint';

export function installGuards(): void {
  const w = window as any;
  if (Object.prototype.hasOwnProperty.call(w, '__llmPageLint')) return;

  // fn.call 을 미리 묶어 둔다. 나중에 페이지가 Function.prototype.call 을 바꿔도 영향이 없다.
  const call = Function.prototype.call;
  const bound = (fn: unknown) => call.bind(fn as (...args: unknown[]) => unknown) as (...args: unknown[]) => any;

  const api = {
    rect: bound(Element.prototype.getBoundingClientRect), // rect(el)
    rangeRects: bound(Range.prototype.getClientRects), // rangeRects(range)
    style: bound(window.getComputedStyle), // style(window, el, pseudo?)
    createRange: bound(Document.prototype.createRange), // createRange(document)
    setStart: bound(Range.prototype.setStart), // setStart(range, node, offset)
    setEnd: bound(Range.prototype.setEnd), // setEnd(range, node, offset)
    createTreeWalker: bound(Document.prototype.createTreeWalker), // createTreeWalker(document, root, what)
    push: bound(Array.prototype.push), // push(arr, item)
  };

  // 원본 속성을 "쓰기 불가 + 재정의 불가"로 고정한다. 페이지의 덮어쓰기는 조용히 실패(엄격 모드면 TypeError).
  const lock = (target: object, name: string) => {
    const d = Object.getOwnPropertyDescriptor(target, name);
    if (!d || !d.configurable || !('value' in d)) return;
    Object.defineProperty(target, name, { value: d.value, writable: false, enumerable: d.enumerable, configurable: false });
  };
  lock(Element.prototype, 'getBoundingClientRect');
  lock(Element.prototype, 'getClientRects');
  lock(Range.prototype, 'getClientRects');
  lock(Range.prototype, 'getBoundingClientRect');
  lock(Range.prototype, 'setStart');
  lock(Range.prototype, 'setEnd');
  lock(Document.prototype, 'createRange');
  lock(Document.prototype, 'createTreeWalker');
  lock(window, 'getComputedStyle');
  lock(Array.prototype, 'push');

  Object.defineProperty(w, '__llmPageLint', {
    value: Object.freeze(api),
    writable: false,
    enumerable: false,
    configurable: false,
  });
}
