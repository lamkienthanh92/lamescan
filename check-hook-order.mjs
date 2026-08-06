// Guards against the class of bug that crashed v8 on first render:
//
//   useEffect(() => { refreshMinimap(); }, [excluded, refreshMinimap]);
//   ...
//   const refreshMinimap = useCallback(...);
//
// A dependency array is an ordinary expression evaluated where it is written, so
// naming a `const` declared further down throws "Cannot access '...' before
// initialization" — at render time, before anything is on screen, with a minified
// name in the stack trace and no hint about which hook is at fault. Nothing in the
// linter's default rules catches it, so it gets a check.
//
// Not a parser, so it is deliberately conservative about what counts as the same
// scope: declarations are tracked per top-level function, and one nested deeper
// than the hook is ignored (a `const blob` inside a callback is not the `blob` a
// component-level hook could be referring to).
import { readFileSync, readdirSync } from 'node:fs';

const indentOf = (line) => line.match(/^\s*/)[0].length;
let problems = 0;

for (const file of readdirSync('./src').filter((f) => /\.jsx?$/.test(f))) {
  const lines = readFileSync('./src/' + file, 'utf8').split('\n');

  // Split into top-level function bodies so two components can't be confused.
  const bounds = [];
  lines.forEach((line, i) => {
    if (/^(export\s+default\s+)?(async\s+)?function\s+[A-Za-z_$]/.test(line)) bounds.push(i);
  });
  bounds.push(lines.length);
  if (bounds.length < 2) bounds.unshift(0);

  for (let b = 0; b < bounds.length - 1; b++) {
    const from = bounds[b];
    const to = bounds[b + 1];
    const declared = new Map(); // name -> { line, indent }
    for (let i = from; i < to; i++) {
      const line = lines[i];
      const ind = indentOf(line);
      const add = (name) => {
        if (/^[A-Za-z_$][\w$]*$/.test(name) && !declared.has(name)) declared.set(name, { line: i, indent: ind });
      };
      const single = line.match(/^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/);
      if (single) add(single[1]);
      const destructured = line.match(/^\s*(?:const|let)\s*[[{]([^\]}]*)[\]}]\s*=/);
      if (destructured) {
        for (const raw of destructured[1].split(',')) add(raw.trim().split(':').pop().trim().replace(/^\.\.\./, ''));
      }
    }

    for (let i = from; i < to; i++) {
      // Two shapes, and the one-line shape matters most: it is exactly how the
      // bug that prompted this check was written.
      //   }, [a, b]);                                   <- multi-line hook ending
      //   useEffect(() => { f(); }, [a, b]);            <- one-liner
      const line = lines[i];
      const isHookLine = /\b(useEffect|useCallback|useMemo|useLayoutEffect|useImperativeHandle)\s*\(/.test(line);
      const isHookTail = /^\s*\}\s*,\s*\[/.test(line);
      if (!isHookLine && !isHookTail) continue;
      const deps = line.match(/,\s*\[([^\]]*)\]\s*\)/);
      if (!deps) continue;
      const hookIndent = indentOf(line);
      for (const raw of deps[1].split(',')) {
        const name = raw.trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
        const d = declared.get(name);
        if (!d || d.line <= i) continue;
        if (d.indent > hookIndent) continue; // nested deeper: different scope
        console.error(
          `  FAIL ${file}:${i + 1} — hook dependency '${name}' is declared later, at line ${d.line + 1}.\n` +
          `       Move the hook below that declaration (or the declaration above the hook).`
        );
        problems++;
      }
    }
  }
}

if (problems > 0) {
  console.error(`\n${problems} hook(s) reference a binding before it exists.`);
  process.exit(1);
}
console.log('  ok  no hook dependency is used before it is declared');
