<!-- Keep this template. Fill every section; delete the guidance lines. -->

## What changed

<!-- One paragraph. Name the organ(s) or host path touched. -->

## Why

<!-- The observed problem or the goal. Link an issue if there is one. -->

## How it was verified

<!-- Paste the real command and its real result. "Should work" is not verification. -->

```
$ npm run verify
$ node workspace/plugins/dsh-organism/scripts/smoke-test.mjs
```

## Numbers that moved

<!-- Any figure quoted in README.md / ARCHITECTURE.md that this change invalidates, and its new value. -->
<!-- Write "none" if nothing measured changed. -->

## Checklist

- [ ] `npm run verify` is green
- [ ] Offline regression added or updated for every organ touched
- [ ] `README.md` **and** `README.zh-CN.md` updated if user-facing behaviour changed
- [ ] `ARCHITECTURE.md` updated if the organ contract, event contracts, or state layout changed
- [ ] No credentials, tokens, or `data/` content in the diff
- [ ] No visible console windows introduced (every spawn carries `windowsHide: true`)

## Attribution

<!-- Delete this section if this change references no external work. -->
<!-- Project, URL, upstream licence. -->
