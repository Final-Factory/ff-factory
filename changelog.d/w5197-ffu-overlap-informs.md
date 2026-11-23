- **FFU requests that edit the same ffu files run at once** (w5197; lothsahn: "Let FFU look requests run at once; each merges
  main before pushing, and the later PR fixes conflicts"). w4553's start check held an FFU request Blocked while other FFU work
  in flight edited one of its files, so five look requests on `crates/ffu-render/src/mesh.wgsl` ran one at a time. The check
  now only informs: the request starts, its start prompt and the start_agent reply name the shared files and with whom, both
  requests' logs get the line, and the other request's worker is told once, so each merges origin/main before pushing and the
  later pull request resolves the conflicts. Code: `server/ffuOverlap.ts`, `Agents.tellFfuShared`.
